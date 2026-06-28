import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position, so spectators know who to turn toward. */
  playerPos: () => THREE.Vector3
  /** Current zone, so onlookers only live on Earth. */
  zone: () => Zone
  /** Sampled ground height at an XZ so a figure stands on the floor. */
  groundY: (x: number, z: number) => number
}

/**
 * Onlookers: an ambient "the city watches you" layer. A fixed set of civilian
 * spectators stand at vantage points on a ring around the plaza (think railings
 * and ledges) and smoothly TURN TO FACE the player whenever the player wanders
 * within range — so roaming feels noticed and the streets read as alive. Out of
 * range they ease back to their original facing and resume a quiet idle sway.
 * Earth-gated and tier-gated; shared geometry, instanced, disposed together.
 *
 * Draw-call budget: every spectator is the same two stylized meshes — a low-poly
 * capsule body + a box head — so the entire crowd renders as exactly TWO
 * InstancedMeshes (2 draw calls) regardless of how many figures there are. The
 * count is tier-gated (high ~18 / medium ~12 / low ~6), but the draw cost is flat.
 * Per-instance matrices are rebuilt each frame from reused scratch objects, so the
 * watch-turn + idle bob cost zero per-frame heap allocation.
 *
 * Animation rides on an accumulated this.t plus dt only (never physics state), so
 * it is deterministic-safe and frame-rate independent. The turn is eased with
 * exp() damping; under config.reducedMotion the idle bob/sway is flattened to a
 * near-steady pose while the turn-to-watch is KEPT (a slow look is not a flash).
 *
 * Seeding: positions, base facings, tints and phases come from a deterministic
 * mulberry32 stream, so the crowd layout is identical every load.
 */

interface Spectator {
  x: number
  y: number        // ground height the feet rest on
  z: number
  baseYaw: number  // facing they return to when the player is out of range
  yaw: number      // current eased facing
  phase: number    // idle-sway phase offset so they don't bob in lockstep
  tint: THREE.Color
}

/** Deterministic PRNG so the onlooker layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const BODY_R = 0.32      // capsule body radius
const BODY_LEN = 0.9     // capsule body cylinder length (between caps)
const HEAD_S = 0.42      // head box edge length
const FEET_TO_MID = 0.95 // body centre height above the feet
const HEAD_RISE = 0.95   // head centre offset above the body centre
const WATCH_R = 38       // distance within which a spectator turns to face the player
const TURN_K = 4         // exp damping rate for the watch turn (higher = snappier)
const RING_MIN = 0.18    // inner ring fraction of world.half
const RING_VAR = 0.22    // ring spread fraction (so radius = half*(MIN..MIN+VAR))

export class Onlookers implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private people: Spectator[] = []
  private t = 0

  private bodyMesh!: THREE.InstancedMesh
  private headMesh!: THREE.InstancedMesh

  // Per-frame scratch (no heap allocation in update()).
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
    const n = tier === 'high' ? 18 : tier === 'medium' ? 12 : 6

    const rnd = mulberry32(515151)
    const half = config.world.half

    // Shared geometry: a low-poly capsule body + a small box head. Both are
    // authored so the figure's feet sit at local y=0 (body centre lifted by
    // FEET_TO_MID, head by FEET_TO_MID + HEAD_RISE), so placing on groundY just
    // means translating to (x, groundY, z).
    const bodyGeo = this.ownG(new THREE.CapsuleGeometry(BODY_R, BODY_LEN, 3, 8))
    const headGeo = this.ownG(new THREE.BoxGeometry(HEAD_S, HEAD_S, HEAD_S))

    // One material per part, shared by every instance; per-figure tint rides on
    // instanceColor. Flat shaded so they stay readable as little neon silhouettes
    // and cost nothing extra on mobile (no lights needed).
    const bodyMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }))
    const headMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }))

    this.bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, n)
    this.headMesh = new THREE.InstancedMesh(headGeo, headMat, n)
    for (const im of [this.bodyMesh, this.headMesh]) {
      // A bounded crowd ringing the plaza; skip per-frame frustum tests.
      im.frustumCulled = false
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.group.add(im)
    }

    // Friendly neon palette for the crowd.
    const tints = [0x49e0ff, 0x9bff6a, 0xffd24a, 0xff5ad0, 0xb07cff, 0xff8a4a]

    // Deterministically place spectators on a ring around the plaza centre. Each
    // gets a base facing that roughly points inward (toward the plaza) plus a
    // little jitter, so resting they read as "watching the square".
    for (let i = 0; i < n; i++) {
      // Spread evenly around the ring with a touch of angular jitter.
      const ang = (i / n) * Math.PI * 2 + (rnd() * 2 - 1) * 0.25
      const radius = half * (RING_MIN + rnd() * RING_VAR)
      const x = Math.cos(ang) * radius
      const z = Math.sin(ang) * radius
      const y = this.deps.groundY(x, z)
      // Inward facing: yaw so the figure looks toward plaza centre, + small jitter.
      const inward = Math.atan2(-x, -z)
      const baseYaw = inward + (rnd() * 2 - 1) * 0.4
      this.people.push({
        x, y, z,
        baseYaw,
        yaw: baseYaw,
        phase: rnd() * 6.28,
        tint: new THREE.Color(tints[(rnd() * tints.length) | 0]),
      })
    }

    // Seed matrices/colours once so the crowd renders correctly on the first frame.
    this.writeInstances()
    this.flush()
    // Tints never change, so set colours once here too.
    if (this.bodyMesh.instanceColor) this.bodyMesh.instanceColor.needsUpdate = true
    if (this.headMesh.instanceColor) this.headMesh.instanceColor.needsUpdate = true

    this.group.visible = this.deps.zone() === 'earth'
    scene.add(this.group)
  }

  /** Shortest signed angular delta from a to b, wrapped to (-PI, PI]. */
  private angleDelta(a: number, b: number): number {
    let d = (b - a) % (Math.PI * 2)
    if (d > Math.PI) d -= Math.PI * 2
    else if (d < -Math.PI) d += Math.PI * 2
    return d
  }

  /** Rebuild every spectator's per-instance matrices + colours (scratch-only). */
  private writeInstances() {
    const reduced = config.reducedMotion
    for (let i = 0; i < this.people.length; i++) {
      const s = this.people[i]

      // Idle sway: a gentle bob + a tiny lean. Flattened under reduced motion so
      // the pose stays steady (the watch-turn below is preserved either way).
      const bob = reduced ? 0 : Math.sin(this.t * 1.7 + s.phase) * 0.05
      const leanY = reduced ? 0 : Math.sin(this.t * 1.1 + s.phase * 1.3) * 0.03

      this.mEuler.set(0, s.yaw, 0)
      this.mQuat.setFromEuler(this.mEuler)
      this.mScl.setScalar(1)

      // Body.
      this.mPos.set(s.x, s.y + FEET_TO_MID + bob, s.z)
      this.mtx.compose(this.mPos, this.mQuat, this.mScl)
      this.bodyMesh.setMatrixAt(i, this.mtx)
      this.scratch.copy(s.tint)
      this.bodyMesh.setColorAt(i, this.scratch)

      // Head: rides above the body, shares yaw, picks up the extra lean bob so it
      // nods subtly relative to the torso.
      this.mPos.set(s.x, s.y + FEET_TO_MID + HEAD_RISE + bob + leanY, s.z)
      this.mtx.compose(this.mPos, this.mQuat, this.mScl)
      this.headMesh.setMatrixAt(i, this.mtx)
      // Head a touch brighter than the body so the silhouette reads clearly.
      this.scratch.copy(s.tint).multiplyScalar(1.25)
      this.headMesh.setColorAt(i, this.scratch)
    }
  }

  /** Mark instance matrix buffers dirty after a batch of writes. */
  private flush() {
    this.bodyMesh.instanceMatrix.needsUpdate = true
    this.headMesh.instanceMatrix.needsUpdate = true
  }

  setZone(zone: Zone) {
    this.group.visible = zone === 'earth'
  }

  update(dt: number) {
    const onEarth = this.deps.zone() === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt

    const p = this.deps.playerPos()
    const r2 = WATCH_R * WATCH_R
    // Frame-rate-independent ease factor for the watch turn.
    const k = 1 - Math.exp(-TURN_K * dt)

    for (let i = 0; i < this.people.length; i++) {
      const s = this.people[i]

      // Pick the target facing: turn toward the player when in range, else ease
      // back to the seeded base facing.
      const dx = p.x - s.x
      const dz = p.z - s.z
      let target: number
      if (dx * dx + dz * dz < r2) {
        // atan2(dx, dz) gives the yaw that points +Z forward toward the player.
        target = Math.atan2(dx, dz)
      } else {
        target = s.baseYaw
      }

      // Ease yaw along the shortest path (handles the -PI/PI wrap cleanly).
      s.yaw += this.angleDelta(s.yaw, target) * k
    }

    this.writeInstances()
    this.flush()
  }

  dispose() {
    this.bodyMesh.dispose()
    this.headMesh.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
