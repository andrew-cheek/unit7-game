import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position, for proximity pickup. */
  playerPos: () => THREE.Vector3
  /** Current zone, so caches only live on Earth. */
  zone: () => Zone
  /** Sampled ground height at an XZ so a cache sits just above the floor. */
  groundY: (x: number, z: number) => number
  /** Called when a cache is opened: award credits + XP and pop a label. */
  onCollect: (x: number, y: number, z: number, credits: number, xp: number) => void
}

/**
 * Hidden caches: a kid-friendly "find the stash" discovery layer. A handful of
 * little glowing crystal caches sit tucked around the neon city; walk within ~3m
 * and a cache "opens" with a quick scale-pop + fade, pays a few credits + XP via a
 * Game callback, then goes on cooldown and respawns at the next deterministic spot.
 * A fixed number stay active at once, so the streets always have something to find.
 * Earth-gated; shared geometry, pooled meshes, disposed together.
 *
 * Draw-call budget: every cache is the same two meshes (a faceted crystal core +
 * an additive glow shell), so both render as a single InstancedMesh each — 2 draws
 * total regardless of count. Caches bob + spin, so per-instance matrices are rebuilt
 * each frame from reused scratch objects (no per-frame heap allocation). The opening
 * pop (scale-up + fade) rides on the per-instance matrix scale + the shell's instance
 * colour. Hidden/cooling caches collapse to a zero-scale matrix.
 *
 * Seeding: positions come from a deterministic mulberry32 stream of (x,z) spots,
 * so the layout is identical every load. There are more seeded spots than live
 * caches; on pickup a cache advances to the next free spot in the stream, giving a
 * "moves somewhere new" feel without ever allocating.
 */

interface Cache {
  spot: number   // index into the seeded spots table this cache currently occupies
  x: number
  y: number      // ground height the cache hovers above
  z: number
  rot: number    // current spin angle
  phase: number  // bob phase offset so they don't pulse in lockstep
  tint: THREE.Color
  credits: number
  xp: number
  cooldown: number // >0 = opened, counting down before it reappears at a new spot
  pop: number      // 0..1 opening animation (scale-up + fade); 1 = mid-open
  opening: boolean // true while playing the pop animation before going to cooldown
}

interface Spot {
  x: number
  y: number
  z: number
}

/** Deterministic PRNG so the cache layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** Module-level constant white, reused for the open flash lerp (no allocation). */
const WHITE = new THREE.Color(0xffffff)

const CORE_R = 0.45     // crystal core radius
const SHELL_R = 0.85    // glow shell radius
const HOVER = 1.1       // base hover height above the ground
const REACH = 3.0       // pickup radius (3D)
const POP_TIME = 0.45   // seconds of opening pop animation
const RESPAWN_MIN = 20  // seconds cooldown before reappearing
const RESPAWN_VAR = 20  // + up to this many seconds

export class HiddenCaches implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private caches: Cache[] = []
  private spots: Spot[] = []
  private nextSpot = 0
  private t = 0

  private coreMesh!: THREE.InstancedMesh
  private shellMesh!: THREE.InstancedMesh

  // Per-frame scratch (no heap allocation in update()).
  private readonly mtx = new THREE.Matrix4()
  private readonly mPos = new THREE.Vector3()
  private readonly mQuat = new THREE.Quaternion()
  private readonly mScl = new THREE.Vector3()
  private readonly mEuler = new THREE.Euler()
  private readonly up = new THREE.Vector3(0, 1, 0)
  private readonly scratch = new THREE.Color()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    const n = tier === 'high' ? 10 : tier === 'medium' ? 7 : 4

    const rnd = mulberry32(70707)
    const reach = config.world.half * 0.8

    // Generate ~3x as many seeded spots as live caches so an opened cache can
    // hop to a fresh location. Spots cycle, so we never run out.
    const nSpots = n * 3
    for (let i = 0; i < nSpots; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const y = this.deps.groundY(x, z)
      this.spots.push({ x, y, z })
    }

    // Shared geometry: a faceted crystal core + a slightly larger glow shell.
    const coreGeo = this.ownG(new THREE.OctahedronGeometry(CORE_R, 0))
    const shellGeo = this.ownG(new THREE.IcosahedronGeometry(SHELL_R, 0))

    // One material per part, shared by every instance; per-cache tint rides on
    // instanceColor. The shell is additive so its instance colour doubles as a
    // brightness/opacity control (dimmer colour reads like lower opacity).
    const coreMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }))
    const shellMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))

    this.coreMesh = new THREE.InstancedMesh(coreGeo, coreMat, n)
    this.shellMesh = new THREE.InstancedMesh(shellGeo, shellMat, n)
    for (const im of [this.coreMesh, this.shellMesh]) {
      // Bounded set spread across the whole map; skip per-frame frustum tests.
      im.frustumCulled = false
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.group.add(im)
    }

    // Friendly bright palette.
    const tints = [0x49e0ff, 0x9bff6a, 0xffd24a, 0xff5ad0, 0xb07cff]
    for (let i = 0; i < n; i++) {
      const spot = this.takeSpot()
      const s = this.spots[spot]
      const tint = new THREE.Color(tints[(rnd() * tints.length) | 0])
      this.caches.push({
        spot, x: s.x, y: s.y, z: s.z,
        rot: rnd() * Math.PI * 2,
        phase: rnd() * 6.28,
        tint,
        credits: 12 + ((rnd() * 12) | 0), // 12..23
        xp: 6 + ((rnd() * 6) | 0),        // 6..11
        cooldown: 0, pop: 0, opening: false,
      })
    }

    // Seed matrices/colours once so caches render correctly on the first frame.
    this.writeInstances()
    this.flush()

    this.group.visible = this.deps.zone() === 'earth'
    scene.add(this.group)
  }

  /** Claim the next seeded spot in the cycling stream that no active cache already
   *  occupies, so two caches never overlap (there are ~3x more spots than caches, so
   *  a free one always exists). Allocation-free: scans the small caches array. */
  private takeSpot(): number {
    for (let tries = 0; tries < this.spots.length; tries++) {
      const i = this.nextSpot
      this.nextSpot = (this.nextSpot + 1) % this.spots.length
      let taken = false
      for (let k = 0; k < this.caches.length; k++) { if (this.caches[k].spot === i) { taken = true; break } }
      if (!taken) return i
    }
    const i = this.nextSpot // fallback (unreachable: spots > caches)
    this.nextSpot = (this.nextSpot + 1) % this.spots.length
    return i
  }

  /** Rebuild every cache's per-instance matrices + colours (scratch-only). */
  private writeInstances() {
    for (let i = 0; i < this.caches.length; i++) {
      const c = this.caches[i]

      // Hidden while cooling (and not mid-open): collapse to zero scale.
      if (c.cooldown > 0 && !c.opening) {
        this.mtx.makeScale(0, 0, 0)
        this.coreMesh.setMatrixAt(i, this.mtx)
        this.shellMesh.setMatrixAt(i, this.mtx)
        continue
      }

      // Opening pop: scale up + fade. Otherwise resting scale 1.
      const grow = c.opening ? 1 + c.pop * 1.4 : 1
      const fade = c.opening ? 1 - c.pop : 1
      const bob = Math.sin(this.t * 1.6 + c.phase) * 0.18
      const py = c.y + HOVER + bob

      // Core: spins on two axes.
      this.mEuler.set(c.rot * 0.5, c.rot, 0)
      this.mQuat.setFromEuler(this.mEuler)
      this.mPos.set(c.x, py, c.z)
      this.mScl.setScalar(grow)
      this.mtx.compose(this.mPos, this.mQuat, this.mScl)
      this.coreMesh.setMatrixAt(i, this.mtx)
      // Core brightens slightly while opening, else a soft pulse on its tint.
      const corePulse = c.opening ? 1 : 0.85 + 0.15 * Math.sin(this.t * 3 + c.phase)
      // Opening white-flash: normally lerps toward white by pop*0.8 (a quick white pop).
      // Under reduced motion, cap the lerp so opening is a gentle brighten, not a strobe.
      const whiteLerp = c.opening ? (config.reducedMotion ? c.pop * 0.25 : c.pop * 0.8) : 0
      this.scratch.copy(c.tint).lerp(WHITE, whiteLerp).multiplyScalar(corePulse)
      this.coreMesh.setColorAt(i, this.scratch)

      // Shell: counter-rotates, hovers in place; additive glow.
      this.mEuler.set(-c.rot * 0.3, -c.rot * 0.6, 0)
      this.mQuat.setFromEuler(this.mEuler)
      this.mScl.setScalar(grow)
      this.mtx.compose(this.mPos, this.mQuat, this.mScl)
      this.shellMesh.setMatrixAt(i, this.mtx)
      // Glow brightness pulses; opening fades it out as it pops.
      const glow = (0.30 + 0.14 * Math.sin(this.t * 2.4 + c.phase)) * fade
      this.scratch.copy(c.tint).multiplyScalar(glow)
      this.shellMesh.setColorAt(i, this.scratch)
    }
  }

  /** Mark instance buffers dirty after a batch of writes. */
  private flush() {
    for (const im of [this.coreMesh, this.shellMesh]) {
      im.instanceMatrix.needsUpdate = true
      if (im.instanceColor) im.instanceColor.needsUpdate = true
    }
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
    const r2 = REACH * REACH

    for (let i = 0; i < this.caches.length; i++) {
      const c = this.caches[i]

      // Mid-open pop animation: grow + fade, then go on cooldown and relocate.
      if (c.opening) {
        c.pop = Math.min(1, c.pop + dt / POP_TIME)
        if (c.pop >= 1) {
          c.opening = false
          c.pop = 0
          c.cooldown = RESPAWN_MIN + Math.random() * RESPAWN_VAR
        }
        continue
      }

      // Cooling: count down, then reappear at the next free seeded spot.
      if (c.cooldown > 0) {
        c.cooldown -= dt
        if (c.cooldown <= 0) {
          c.cooldown = 0
          const spot = this.takeSpot()
          const s = this.spots[spot]
          c.spot = spot
          c.x = s.x; c.y = s.y; c.z = s.z
          c.phase = (c.phase + 1.7) % 6.28
        }
        continue
      }

      // Idle spin.
      c.rot += dt * 0.8

      // Pickup: player close in 3D (account for the hover height).
      const dx = c.x - p.x
      const dy = (c.y + HOVER) - p.y
      const dz = c.z - p.z
      if (dx * dx + dy * dy + dz * dz < r2) {
        this.deps.onCollect(c.x, c.y + HOVER, c.z, c.credits, c.xp)
        c.opening = true
        c.pop = 0
      }
    }

    this.writeInstances()
    this.flush()
  }

  dispose() {
    this.coreMesh.dispose()
    this.shellMesh.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
