import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position, read each update to decide where to stamp a print. */
  playerPos: () => THREE.Vector3
  /** Current zone, so prints only exist on the Moon. */
  zone: () => Zone
  /** Sampled ground height at an XZ, so a print lies flat on the lunar surface. */
  groundY: (x: number, z: number) => number
}

/**
 * Moon bootprints: the iconic Apollo "footprints in the dust" beat. As the player
 * walks the lunar surface this leaves a visible trail of small dark oval prints
 * pressed flat into the regolith — a record of where you've explored — that slowly
 * fade back into the ground over time.
 *
 * One draw call: every print is the same flat oval decal rendered from a single
 * InstancedMesh (~1 draw regardless of count). A fixed-capacity ring buffer of
 * print slots is reused forever; the oldest print is overwritten once the buffer
 * is full, and faded slots collapse to a zero-scale matrix. Per-slot age + colour
 * lerp (fresh dark tone -> ground tone) ride on instanceColor. All transforms are
 * built from reused scratch Vector3/Matrix4 — zero per-frame heap allocation.
 *
 * MOON only, pure render layer: it READS the player position to know where to
 * stamp and never writes player/physics state. Stamping is gated on DISTANCE
 * MOVED (a ~1.1m stride), not on time, so the trail is identical at any frame rate.
 *
 * Ring-buffer pool sizes (config.tier.name):
 *   high   -> 240 prints
 *   medium -> 140 prints
 *   low    ->  60 prints
 */

const STRIDE = 1.1        // metres of ground travel between stamps
const PRINT_LEN = 0.42    // print half-length along travel (oval)
const PRINT_WID = 0.24    // print half-width across travel
const LATERAL = 0.18      // left/right offset from the centre line (footsteps, not a smear)
const LIFT = 0.03         // sit just above the surface to avoid z-fighting
const FADE_TIME = 26      // seconds for a fresh print to fully fade into the ground

export class MoonTracks implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private zone: Zone = 'earth'

  private mesh!: THREE.InstancedMesh
  private readonly cap: number

  // Ring-buffer state.
  private cursor = 0            // next slot to (over)write
  private foot = 0             // alternates 0/1 for left/right lateral offset
  private hasLast = false       // whether lastStamp holds a valid previous position
  private readonly ages: Float32Array      // per-slot age in seconds (>= FADE_TIME or -1 = free)
  private readonly active: Uint8Array       // per-slot live flag

  // Reused scratch (no allocation in update()).
  private readonly lastStamp = new THREE.Vector3()
  private readonly travel = new THREE.Vector3()
  private readonly perp = new THREE.Vector3()
  private readonly mPos = new THREE.Vector3()
  private readonly mQuat = new THREE.Quaternion()
  private readonly mScale = new THREE.Vector3()
  private readonly mEuler = new THREE.Euler()
  private readonly mMat = new THREE.Matrix4()
  private readonly cFresh = new THREE.Color(0x2a2d31) // pressed-print dark tone
  private readonly cGround = new THREE.Color(0x6f747a) // lunar ground tone (matches crater rock)
  private readonly scratch = new THREE.Color()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    this.cap = tier === 'high' ? 240 : tier === 'medium' ? 140 : 60

    this.ages = new Float32Array(this.cap)
    this.active = new Uint8Array(this.cap)

    // A flat low-segment circle, laid horizontal and squashed into an oval, reads
    // as a pressed bootprint slightly darker than the dust.
    const geo = this.ownG(new THREE.CircleGeometry(1, 12))
    const mat = this.own(new THREE.MeshBasicMaterial({
      color: 0xffffff, // tint comes entirely from instanceColor
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      fog: true,
    }))

    this.mesh = new THREE.InstancedMesh(geo, mat, this.cap)
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.group.add(this.mesh)

    // Start every slot hidden (zero scale) + free.
    this.reset()

    this.group.visible = false
    scene.add(this.group)
  }

  /** Clear all prints + reset the ring cursor so re-entry starts on fresh dust. */
  private reset() {
    this.cursor = 0
    this.foot = 0
    this.hasLast = false
    this.mMat.makeScale(0, 0, 0)
    for (let i = 0; i < this.cap; i++) {
      this.ages[i] = -1
      this.active[i] = 0
      this.mesh.setMatrixAt(i, this.mMat)
      this.mesh.setColorAt(i, this.cGround)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /** Press a fresh print into the surface at the player's feet (alternating side). */
  private stamp(px: number, pz: number) {
    // Lateral offset perpendicular to travel so prints land left/right of the
    // centre line, reading as footsteps rather than one centred smear.
    const side = this.foot === 0 ? 1 : -1
    this.foot ^= 1
    const ox = px + this.perp.x * LATERAL * side
    const oz = pz + this.perp.z * LATERAL * side
    const gy = this.deps.groundY(ox, oz)

    // Orient the oval flat on the ground, long axis along the travel direction.
    const heading = Math.atan2(this.travel.x, this.travel.z)
    this.mEuler.set(-Math.PI / 2, heading, 0)
    this.mQuat.setFromEuler(this.mEuler)
    this.mPos.set(ox, gy + LIFT, oz)
    this.mScale.set(PRINT_WID, PRINT_LEN, 1) // CircleGeometry lies in XY; scale before the X-rotate
    this.mMat.compose(this.mPos, this.mQuat, this.mScale)

    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.cap
    this.mesh.setMatrixAt(i, this.mMat)
    this.mesh.setColorAt(i, this.cFresh)
    this.ages[i] = 0
    this.active[i] = 1
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'moon'
    if (zone !== 'moon') this.reset()
  }

  update(dt: number) {
    const active = this.deps.zone() === 'moon'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return

    const p = this.deps.playerPos()

    // Stamp gating: only when the player is on foot / near the ground.
    const gy = this.deps.groundY(p.x, p.z)
    const grounded = Math.abs(p.y - gy) <= 2.0

    if (!this.hasLast) {
      // First grounded frame on the Moon: seed the last position without stamping.
      if (grounded) { this.lastStamp.set(p.x, 0, p.z); this.hasLast = true }
    } else if (grounded) {
      // Distance gating (frame-rate independent): stamp once per stride moved.
      // Loop in case a big jump in position crossed several strides at once.
      const dx = p.x - this.lastStamp.x
      const dz = p.z - this.lastStamp.z
      const dist = Math.hypot(dx, dz)
      if (dist >= STRIDE) {
        // Travel direction (flattened to XZ) for orientation + perpendicular.
        this.travel.set(dx, 0, dz).normalize()
        this.perp.set(this.travel.z, 0, -this.travel.x) // right-hand perpendicular in XZ
        let walked = dist
        while (walked >= STRIDE) {
          // Advance the last-stamp marker one stride along travel and stamp there.
          this.lastStamp.x += this.travel.x * STRIDE
          this.lastStamp.z += this.travel.z * STRIDE
          this.stamp(this.lastStamp.x, this.lastStamp.z)
          walked -= STRIDE
        }
      }
    } else {
      // Airborne (jetpack / hoverboard hop): keep the last marker chasing the
      // player so we don't draw a long phantom drag line on touchdown.
      this.lastStamp.x = p.x
      this.lastStamp.z = p.z
    }

    // Fade live prints toward the ground tone; free them once fully faded.
    let colorDirty = false
    for (let i = 0; i < this.cap; i++) {
      if (this.active[i] === 0) continue
      const age = this.ages[i] + dt
      this.ages[i] = age
      const k = age / FADE_TIME
      if (k >= 1) {
        // Fully faded: collapse to zero scale and free the slot for reuse.
        this.mMat.makeScale(0, 0, 0)
        this.mesh.setMatrixAt(i, this.mMat)
        this.mesh.setColorAt(i, this.cGround)
        this.ages[i] = -1
        this.active[i] = 0
        this.mesh.instanceMatrix.needsUpdate = true
        colorDirty = true
      } else {
        this.scratch.copy(this.cFresh).lerp(this.cGround, k)
        this.mesh.setColorAt(i, this.scratch)
        colorDirty = true
      }
    }
    if (colorDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  dispose() {
    this.mesh.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
