import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

/**
 * Constructor deps. The orchestrator routes the reward callback to
 * credits/XP/popup/audio; this system never touches HUD/credits directly.
 *
 *   {
 *     // Player world position, sampled each frame for proximity pickup.
 *     playerPos: () => THREE.Vector3
 *     // Current zone. Samples are ACTIVE + visible only on 'moon'/'mars'; hidden
 *     // on 'earth'. Read every frame (and via setZone) so a zone change flips state.
 *     zone: () => Zone
 *     // Sampled ground height at an XZ so a sample sits just above the floor.
 *     groundY: (x: number, z: number) => number
 *     // Award for a collected sample. credits/xp are MODEST; (x,y,z) is the world
 *     // pop position; label is a short tag e.g. 'SAMPLE' / 'SAMPLE x3'.
 *     onReward: (credits: number, xp: number, x: number, y: number, z: number, label: string) => void
 *   }
 */
interface Deps {
  playerPos: () => THREE.Vector3
  zone: () => Zone
  groundY: (x: number, z: number) => number
  onReward: (credits: number, xp: number, x: number, y: number, z: number, label: string) => void
}

/**
 * Off-world alien SAMPLES: a kid-friendly "collect the find" layer that gives the
 * Moon and Mars a reason to roam. A handful of glowing sample nodes sit on the
 * ground at deterministic seeded spots; walk within ~3m and a node "collects" with
 * a quick scale-pop + fade, pays MODEST credits + XP via the onReward callback, then
 * goes on a short cooldown and respawns at the next free seeded spot. A fixed number
 * stay active at once, so there is always something to find. Off-world-gated; shared
 * geometry, pooled instances, disposed together.
 *
 * Combo: collecting samples in quick succession builds a small chain that adds a
 * slightly bigger bonus on the run. Letting the timer lapse just resets the chain —
 * there is no fail state and no punishment, only a forfeited bonus.
 *
 * Distinct per zone: Moon = pale mineral crystals (cyan/white); Mars = warm
 * bio-samples (amber/green). The palette swaps on setZone so the find reads as
 * native to the world the player is standing in.
 *
 * Draw-call budget: every node is the same two meshes (a faceted crystal/egg core +
 * an additive glow shell), so both render as a single InstancedMesh each — 2 draws
 * total regardless of count. Nodes bob + spin, so per-instance matrices are rebuilt
 * each frame from reused scratch objects (no per-frame heap allocation). The pickup
 * pop (scale-up + fade) rides on the per-instance matrix scale + the shell colour.
 * Hidden/cooling nodes collapse to a zero-scale matrix.
 *
 * Seeding: positions come from a deterministic mulberry32 stream of (x,z) spots, so
 * the layout is identical every load. There are more seeded spots than live nodes;
 * on pickup a node advances to the next FREE spot in the stream (skipping any spot an
 * active node already holds, mirroring HiddenCaches), so two never overlap.
 */

interface Sample {
  spot: number   // index into the seeded spots table this node currently occupies
  x: number
  y: number      // ground height the node hovers just above
  z: number
  rot: number    // current spin angle
  phase: number  // bob phase offset so they don't pulse in lockstep
  credits: number
  xp: number
  cooldown: number // >0 = collected, counting down before it reappears at a new spot
  pop: number      // 0..1 pickup animation (scale-up + fade)
  popping: boolean // true while playing the pop animation before going to cooldown
}

interface Spot {
  x: number
  y: number
  z: number
}

/** Deterministic PRNG so the sample layout is identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** Module-level constant white, reused for the pop flash lerp (no allocation). */
const WHITE = new THREE.Color(0xffffff)

const CORE_R = 0.42      // crystal/egg core radius
const SHELL_R = 0.8      // glow shell radius
const HOVER = 0.9        // base hover height above the ground (low, sits near the floor)
const REACH = 3.0        // pickup radius (3D)
const POP_TIME = 0.4     // seconds of pickup pop animation
const RESPAWN_MIN = 8    // seconds cooldown before reappearing
const RESPAWN_VAR = 8    // + up to this many seconds
// Combo: rapid successive pickups chain for a slightly bigger bonus.
const CHAIN_WINDOW = 6   // seconds after a pickup the chain stays alive
const CHAIN_MAX = 5      // chain caps here (keeps the economy modest)

// Per-zone look. Moon = pale mineral crystals (cyan/white); Mars = warm bio (amber/green).
const MOON_CORE = 0xdff6ff
const MOON_GLOW = 0x49e0ff
const MARS_CORE = 0xffd9a0
const MARS_GLOW = 0xffa23a
const MARS_GLOW2 = 0x8bff6a

export class OffworldSamples implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private samples: Sample[] = []
  private spots: Spot[] = []
  private nextSpot = 0
  private t = 0
  private zone: Zone = 'earth'
  private chain = 0          // current combo length
  private chainTimer = 0     // seconds of chain life remaining

  private coreMesh!: THREE.InstancedMesh
  private shellMesh!: THREE.InstancedMesh

  // Per-zone tints, swapped in setZone (no per-frame allocation).
  private coreTint = new THREE.Color(MOON_CORE)
  private glowTint = new THREE.Color(MOON_GLOW)

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
    const n = tier === 'high' ? 12 : tier === 'medium' ? 8 : 5

    const rnd = mulberry32(53129)
    const reach = config.world.half * 0.85

    // Generate ~3x as many seeded spots as live nodes so a collected node can hop
    // to a fresh location. Spots cycle, so we never run out.
    const nSpots = n * 3
    for (let i = 0; i < nSpots; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      const y = this.deps.groundY(x, z)
      this.spots.push({ x, y, z })
    }

    // Shared geometry: a faceted crystal/egg core + a slightly larger glow shell.
    const coreGeo = this.ownG(new THREE.IcosahedronGeometry(CORE_R, 0))
    const shellGeo = this.ownG(new THREE.IcosahedronGeometry(SHELL_R, 0))

    // One material per part, shared by every instance; per-node tint rides on
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

    for (let i = 0; i < n; i++) {
      const spot = this.takeSpot()
      const s = this.spots[spot]
      this.samples.push({
        spot, x: s.x, y: s.y, z: s.z,
        rot: rnd() * Math.PI * 2,
        phase: rnd() * 6.28,
        credits: 6 + ((rnd() * 5) | 0), // 6..10 (modest)
        xp: 3 + ((rnd() * 4) | 0),      // 3..6
        cooldown: 0, pop: 0, popping: false,
      })
    }

    // Seed matrices/colours once so nodes render correctly on the first frame.
    this.writeInstances()
    this.flush()

    // Off-world only: hidden on Earth.
    this.zone = this.deps.zone()
    this.applyZoneTints()
    this.group.visible = this.zone !== 'earth'
    scene.add(this.group)
  }

  /** Swap core/glow tints for the current off-world zone (allocation-free copy). */
  private applyZoneTints() {
    if (this.zone === 'mars') {
      this.coreTint.set(MARS_CORE)
      this.glowTint.set(MARS_GLOW)
    } else {
      // Moon (and the inert Earth case, never shown) uses the pale mineral look.
      this.coreTint.set(MOON_CORE)
      this.glowTint.set(MOON_GLOW)
    }
  }

  /** Claim the next seeded spot in the cycling stream that no active node already
   *  occupies, so two nodes never overlap (there are ~3x more spots than nodes, so a
   *  free one always exists). Allocation-free: scans the small samples array. */
  private takeSpot(): number {
    for (let tries = 0; tries < this.spots.length; tries++) {
      const i = this.nextSpot
      this.nextSpot = (this.nextSpot + 1) % this.spots.length
      let taken = false
      for (let k = 0; k < this.samples.length; k++) { if (this.samples[k].spot === i) { taken = true; break } }
      if (!taken) return i
    }
    const i = this.nextSpot // fallback (unreachable: spots > samples)
    this.nextSpot = (this.nextSpot + 1) % this.spots.length
    return i
  }

  /** Rebuild every node's per-instance matrices + colours (scratch-only). */
  private writeInstances() {
    // Mars mixes a second warm-green glow tint across nodes for variety; pick by
    // node phase so it's stable per node and allocation-free.
    for (let i = 0; i < this.samples.length; i++) {
      const c = this.samples[i]

      // Hidden while cooling (and not mid-pop): collapse to zero scale.
      if (c.cooldown > 0 && !c.popping) {
        this.mtx.makeScale(0, 0, 0)
        this.coreMesh.setMatrixAt(i, this.mtx)
        this.shellMesh.setMatrixAt(i, this.mtx)
        continue
      }

      // Pickup pop: scale up + fade. Otherwise resting scale 1.
      const grow = c.popping ? 1 + c.pop * 1.5 : 1
      const fade = c.popping ? 1 - c.pop : 1
      const bob = Math.sin(this.t * 1.5 + c.phase) * 0.16
      const py = c.y + HOVER + bob

      // Core: a faceted crystal/egg, spins on two axes.
      this.mEuler.set(c.rot * 0.5, c.rot, 0)
      this.mQuat.setFromEuler(this.mEuler)
      this.mPos.set(c.x, py, c.z)
      // Slight vertical stretch sells the "egg" read without a second geometry.
      this.mScl.set(grow, grow * 1.25, grow)
      this.mtx.compose(this.mPos, this.mQuat, this.mScl)
      this.coreMesh.setMatrixAt(i, this.mtx)
      // Core brightens while popping, else a soft pulse on the zone core tint.
      const corePulse = c.popping ? 1 : 0.82 + 0.18 * Math.sin(this.t * 3 + c.phase)
      this.scratch.copy(this.coreTint).lerp(WHITE, c.popping ? c.pop * 0.8 : 0).multiplyScalar(corePulse)
      this.coreMesh.setColorAt(i, this.scratch)

      // Shell: counter-rotates, hovers; additive glow.
      this.mEuler.set(-c.rot * 0.3, -c.rot * 0.6, 0)
      this.mQuat.setFromEuler(this.mEuler)
      this.mScl.setScalar(grow)
      this.mtx.compose(this.mPos, this.mQuat, this.mScl)
      this.shellMesh.setMatrixAt(i, this.mtx)
      // Glow brightness pulses; pop fades it out. On Mars, every other node gets the
      // green bio glow for variety (stable per node via its index parity).
      const glow = (0.28 + 0.13 * Math.sin(this.t * 2.4 + c.phase)) * fade
      if (this.zone === 'mars' && (i & 1)) this.scratch.set(MARS_GLOW2).multiplyScalar(glow)
      else this.scratch.copy(this.glowTint).multiplyScalar(glow)
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
    this.zone = zone
    const off = zone !== 'earth'
    this.group.visible = off
    if (off) {
      this.applyZoneTints()
      // Refresh colours immediately so the new zone palette shows on frame one.
      this.writeInstances()
      this.flush()
    } else {
      // Leaving off-world: drop any combo so it can't carry back to Earth.
      this.chain = 0
      this.chainTimer = 0
    }
  }

  update(dt: number) {
    const off = this.zone !== 'earth'
    if (this.group.visible !== off) this.group.visible = off
    if (!off) return
    this.t += dt

    // Decay the combo chain; lapsing just resets it (no punishment).
    if (this.chainTimer > 0) {
      this.chainTimer -= dt
      if (this.chainTimer <= 0) { this.chainTimer = 0; this.chain = 0 }
    }

    const p = this.deps.playerPos()
    const r2 = REACH * REACH

    for (let i = 0; i < this.samples.length; i++) {
      const c = this.samples[i]

      // Mid-pop animation: grow + fade, then go on cooldown and relocate.
      if (c.popping) {
        c.pop = Math.min(1, c.pop + dt / POP_TIME)
        if (c.pop >= 1) {
          c.popping = false
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
        // Build/refresh the combo chain.
        this.chain = Math.min(CHAIN_MAX, this.chain + 1)
        this.chainTimer = CHAIN_WINDOW
        // Chain bonus: small per-link extra credits + XP for a rewarding streak.
        const bonusC = (this.chain - 1) * 2
        const bonusX = (this.chain - 1) * 1
        const label = this.chain > 1 ? 'SAMPLE x' + this.chain : 'SAMPLE'
        this.deps.onReward(c.credits + bonusC, c.xp + bonusX, c.x, c.y + HOVER, c.z, label)
        c.popping = true
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
