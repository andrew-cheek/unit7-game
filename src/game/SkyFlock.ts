import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so the flock wheels through the sky around wherever you are. */
  focus: () => THREE.Vector3
}

interface Boid {
  mesh: THREE.Mesh
  pos: THREE.Vector3
  vel: THREE.Vector3
  bank: number // eased roll toward the current turn
}

/** Deterministic PRNG so the flock spawns the same each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Earth-roam atmosphere: a loose flock of small glowing neon "birds" that wheel
 * and bank through the sky high over the city, drifting in big slow arcs around
 * the player. Lightweight boids (cohesion / alignment / separation) plus a gentle
 * pull back toward the player so they never wander off. Additive, no colliders,
 * way up out of reach. One shared wing geometry + one shared material; pooled +
 * Earth-gated, disposed together.
 */
export class SkyFlock implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private boids: Boid[] = []
  private zone: Zone = 'earth'
  private t = 0

  // Pre-allocated scratch so update() never touches the heap.
  private center = new THREE.Vector3()
  private heading = new THREE.Vector3()
  private cohesion = new THREE.Vector3()
  private align = new THREE.Vector3()
  private separation = new THREE.Vector3()
  private toCenter = new THREE.Vector3()
  private accel = new THREE.Vector3()
  private offset = new THREE.Vector3()
  private fwd = new THREE.Vector3()
  private zAxis = new THREE.Vector3(0, 0, 1) // constant source for orientation
  private quat = new THREE.Quaternion()

  // Loose flocking tuning.
  private readonly minSpeed = 7
  private readonly maxSpeed = 14
  private readonly neighborR = 22
  private readonly separateR = 9
  private readonly orbitR = 130 // radius the flock likes to keep from the player
  private readonly flyY = 68 // centre height of the flock band

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const n = low ? 8 : 18
    const rnd = mulberry32(51731)

    // One shared flattened "wing" shape: a wide, very shallow cone reads as a
    // glowing delta-wing / bird silhouette from below. Shared across every boid.
    const wingGeo = this.ownG(new THREE.ConeGeometry(0.9, 2.4, 3))
    wingGeo.rotateX(Math.PI / 2) // point the cone down +z (travel direction)
    wingGeo.scale(1, 0.18, 1) // flatten it into a wing
    // One shared additive material so the whole flock is a single draw-state.
    const mat = this.own(new THREE.MeshBasicMaterial({ color: 0x6fe4ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))

    // Seed the flock in a loose cluster high in the sky off to one side.
    const seedA = rnd() * Math.PI * 2
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(wingGeo, mat)
      mesh.scale.setScalar(1.6 + rnd() * 0.8)
      const px = Math.cos(seedA) * this.orbitR + (rnd() * 2 - 1) * 30
      const pz = Math.sin(seedA) * this.orbitR + (rnd() * 2 - 1) * 30
      const py = this.flyY + (rnd() * 2 - 1) * 14
      const pos = new THREE.Vector3(px, py, pz)
      // Initial velocity tangent to the orbit, so they start already wheeling.
      const vel = new THREE.Vector3(-Math.sin(seedA), 0, Math.cos(seedA)).multiplyScalar(this.maxSpeed)
      mesh.position.copy(pos)
      this.group.add(mesh)
      this.boids.push({ mesh, pos, vel, bank: 0 })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    // Drive visibility from the zone each frame so it's correct at startup too
    // (setZone only fires on a zone *change*, and you begin on Earth).
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt
    const f = this.deps.focus()
    const boids = this.boids
    const n = boids.length

    // Flock center + average heading (one pass; reused by every boid).
    this.center.set(0, 0, 0)
    this.heading.set(0, 0, 0)
    for (let i = 0; i < n; i++) { this.center.add(boids[i].pos); this.heading.add(boids[i].vel) }
    this.center.multiplyScalar(1 / n)
    if (this.heading.lengthSq() > 1e-6) this.heading.normalize()

    const neighborR2 = this.neighborR * this.neighborR
    const separateR2 = this.separateR * this.separateR

    for (let i = 0; i < n; i++) {
      const b = boids[i]
      this.cohesion.set(0, 0, 0)
      this.align.set(0, 0, 0)
      this.separation.set(0, 0, 0)
      let near = 0

      // O(n^2) over the small flock: cohesion, alignment, separation.
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const o = boids[j]
        this.offset.subVectors(b.pos, o.pos)
        const d2 = this.offset.lengthSq()
        if (d2 < neighborR2) {
          this.cohesion.add(o.pos)
          this.align.add(o.vel)
          near++
          if (d2 < separateR2 && d2 > 1e-4) {
            // Push away, weighted stronger the closer the neighbor is.
            this.separation.addScaledVector(this.offset, 1 / d2)
          }
        }
      }

      this.accel.set(0, 0, 0)
      if (near > 0) {
        this.cohesion.multiplyScalar(1 / near).sub(b.pos)
        this.accel.addScaledVector(this.cohesion, 0.6)
        this.align.multiplyScalar(1 / near)
        this.accel.addScaledVector(this.align, 0.5)
      }
      this.accel.addScaledVector(this.separation, 18)

      // Gentle attraction that keeps the whole flock orbiting the player: steer
      // toward a point on a ring of radius orbitR around the focus, at flyY, so
      // it wheels around you in big slow arcs instead of drifting off.
      this.toCenter.set(this.center.x - f.x, 0, this.center.z - f.z)
      const cd = this.toCenter.length()
      if (cd > 1e-3) this.toCenter.multiplyScalar(1 / cd); else this.toCenter.set(1, 0, 0)
      // Desired ring point for the flock center, plus a slow tangential swirl.
      const swirl = Math.sin(this.t * 0.05) * 0.6
      const tx = -this.toCenter.z, tz = this.toCenter.x // tangent
      const targetX = f.x + (this.toCenter.x + tx * swirl) * this.orbitR
      const targetZ = f.z + (this.toCenter.z + tz * swirl) * this.orbitR
      this.toCenter.set(targetX - b.pos.x, this.flyY - b.pos.y, targetZ - b.pos.z)
      this.accel.addScaledVector(this.toCenter, 0.012)

      // Soft height keeper so the band stays high (y ~ 45..90).
      this.accel.y += (this.flyY - b.pos.y) * 0.02
      // A little vertical waft so the flock undulates as it banks.
      this.accel.y += Math.sin(this.t * 0.6 + i * 0.7) * 1.2

      // Integrate velocity, clamp speed so the motion stays graceful.
      b.vel.addScaledVector(this.accel, dt)
      const sp = b.vel.length()
      if (sp > this.maxSpeed) b.vel.multiplyScalar(this.maxSpeed / sp)
      else if (sp < this.minSpeed && sp > 1e-4) b.vel.multiplyScalar(this.minSpeed / sp)
      b.pos.addScaledVector(b.vel, dt)
      b.mesh.position.copy(b.pos)

      // Orient along travel, then bank: roll toward the turn so it reads as a
      // wheeling bird. Turn amount = how much accel points sideways of heading.
      this.fwd.copy(b.vel)
      const fl = this.fwd.length()
      if (fl > 1e-4) {
        this.fwd.multiplyScalar(1 / fl)
        // Signed sideways component of acceleration => bank direction/strength.
        const sideX = -this.fwd.z, sideZ = this.fwd.x // right vector (XZ)
        const turn = (this.accel.x * sideX + this.accel.z * sideZ) * 0.05
        const targetBank = THREE.MathUtils.clamp(turn, -0.9, 0.9)
        b.bank += (targetBank - b.bank) * Math.min(1, dt * 4)
        // Base orientation faces +z down the velocity, then roll about it.
        this.quat.setFromUnitVectors(this.zAxis, this.fwd)
        b.mesh.quaternion.copy(this.quat)
        b.mesh.rotateZ(b.bank)
        // gentle pitch into the climb/dive
        b.mesh.rotateX(THREE.MathUtils.clamp(-b.vel.y * 0.03, -0.5, 0.5))
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
