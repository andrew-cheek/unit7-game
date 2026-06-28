import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Local player position, for the spawn band + proximity tag. */
  playerPos: () => THREE.Vector3
  /** Current zone, so the fauna only live on Mars (hard-gated each update). */
  zone: () => Zone
  /** Sampled ground height at an XZ so a burrower erupts from / dives into the floor. */
  groundY: (x: number, z: number) => number
  /** Fired once when a surfaced burrower is tagged: award credits + XP and pop a label. */
  onReward: (credits: number, xp: number, x: number, y: number, z: number, label: string) => void
}

/**
 * Mars-only native fauna: worm-like sand-burrowers. They lurk DORMANT under the
 * regolith, then on a seeded timer erupt near the player in a puff of dust, arc
 * their short segmented body up through the thin air, hang for a couple seconds,
 * and dive back under to cool down. Walk within ~3m of a surfaced one to "tag" it
 * for an XP/credit reward, which makes it dive early. Self-contained discovery
 * layer - it has NO coupling to the net-gun: it only READS playerPos and fires a
 * discrete onReward event, never writing player/physics state, so it is fully
 * determinism-safe (render-only except that one callback).
 *
 * Draw-call budget: ~2-3 draws total. Every body segment of every creature shares
 * ONE InstancedMesh of a low-poly capsule, and the emergence dust-burst shares ONE
 * additive InstancedMesh of puff billboards. Inactive segments/puffs collapse to a
 * zero-scale matrix. All motion is per-instance matrices rebuilt from reused scratch
 * objects each frame - no per-frame heap allocation. Mars-gated + tier-gated count.
 * config.reducedMotion is read LIVE: it softens / dims the dust burst (no bright
 * flash) and eases the arc, keeping it calm. Pooled, disposed together.
 */

type Phase = 'dormant' | 'surfaced' | 'diving'

interface Burrower {
  // Resting / surfacing footprint.
  x: number
  z: number
  gy: number       // ground height at (x,z)
  heading: number  // body axis direction in the XZ plane (radians)
  phase: Phase
  timer: number    // dormant: countdown to next emerge; surfaced: time left up; diving: progress
  arc: number      // 0..1 emergence/dive progress (drives the sine arc height)
  height: number   // peak arc height for this surfacing
  length: number   // body length along the heading (segment spacing)
  pop: number      // 0..1 quick scale-pop when tagged (decays)
  tagged: boolean  // already rewarded this surfacing (latch so onReward fires once)
  tint: THREE.Color
  credits: number
  xp: number
  burst: number    // 0..1 dust-burst life on emergence (decays)
}

/** Deterministic PRNG so the layout / timers / rewards are reproducible each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const SEGMENTS = 5           // body segments per creature
const SEG_R = 0.55           // segment (capsule) radius
const PUFFS = 6              // dust billboards per creature on emergence
const REACH = 3.0            // proximity tag radius (3D)
const BAND_MIN = 8           // spawn band: don't erupt closer than this to the player
const BAND_MAX = 40          // ...nor farther than this
const SURFACE_TIME = 2.5     // seconds a burrower hangs surfaced before diving
const EMERGE_TIME = 0.55     // seconds to arc up out of the ground
const DIVE_TIME = 0.7        // seconds to dive back under
const POP_TIME = 0.35        // tag scale-pop duration
const BURST_TIME = 0.7       // dust-burst fade duration
const COOL_MIN = 7           // dormant cooldown floor (seconds)
const COOL_VAR = 9           // ...plus up to this

export class Burrowers implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private creatures: Burrower[] = []
  private zone: Zone = 'earth'
  private t = 0
  private surfacedCount = 0    // how many are currently up (cap on low)
  private maxSurfaced: number
  private rnd: () => number

  private bodyMesh!: THREE.InstancedMesh   // SEGMENTS * n segment instances
  private dustMesh!: THREE.InstancedMesh    // PUFFS * n puff instances (additive)

  // Per-frame scratch - no heap allocation in update().
  private readonly mtx = new THREE.Matrix4()
  private readonly mPos = new THREE.Vector3()
  private readonly mQuat = new THREE.Quaternion()
  private readonly mScl = new THREE.Vector3()
  private readonly mEuler = new THREE.Euler()
  private readonly scratch = new THREE.Color()
  private readonly ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const tier = config.tier.name
    const n = tier === 'high' ? 8 : tier === 'medium' ? 5 : 3
    // Only 1-2 surfaced at once on low; a touch more headroom on richer tiers.
    this.maxSurfaced = tier === 'high' ? 4 : tier === 'medium' ? 3 : 2

    const rnd = mulberry32(690413)
    this.rnd = rnd
    const reach = 140 // Mars fields are sparse; scatter the resting roots wide.

    // Shared low-poly geometry. Capsule = stubby worm segment; the puff is a tiny
    // sphere used as an additive billboard for the dust burst.
    const segGeo = this.ownG(new THREE.CapsuleGeometry(SEG_R, 0.35, 3, 6))
    const puffGeo = this.ownG(new THREE.SphereGeometry(0.5, 6, 5))

    // One material per part, shared by every instance; per-creature tint rides on
    // instanceColor. The dust is additive so its instance colour doubles as a
    // brightness/opacity control (dimmer colour reads as more transparent).
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.05, fog: true }))
    const dustMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: true }))

    this.bodyMesh = new THREE.InstancedMesh(segGeo, bodyMat, SEGMENTS * n)
    this.dustMesh = new THREE.InstancedMesh(puffGeo, dustMat, PUFFS * n)
    for (const im of [this.bodyMesh, this.dustMesh]) {
      // One system spanning the whole field - skip per-frame frustum tests.
      im.frustumCulled = false
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.group.add(im)
    }
    // Per-instance colour buffers (tint + dust brightness).
    this.bodyMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SEGMENTS * n * 3), 3)
    this.dustMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PUFFS * n * 3), 3)

    // Dusty Mars-fauna palette: rust, ochre, pale sand-green.
    const tints = [0xc9774a, 0xd8a14f, 0xb6c08a, 0xa85a3a, 0xd4b483]
    for (let i = 0; i < n; i++) {
      const x = (rnd() * 2 - 1) * reach
      const z = (rnd() * 2 - 1) * reach
      this.creatures.push({
        x, z, gy: this.deps.groundY(x, z),
        heading: rnd() * Math.PI * 2,
        phase: 'dormant',
        timer: COOL_MIN + rnd() * (COOL_VAR + 6), // staggered first emerge
        arc: 0,
        height: 1.6 + rnd() * 1.2,
        length: 1.5 + rnd() * 0.9,
        pop: 0,
        tagged: false,
        tint: new THREE.Color(tints[(rnd() * tints.length) | 0]),
        credits: 12 + ((rnd() * 11) | 0), // 12..22
        xp: 6 + ((rnd() * 6) | 0),         // 6..11
        burst: 0,
      })
    }

    // Seed matrices/colours once so the first frame renders correctly (all dormant
    // => all collapsed to zero scale, but colours are valid).
    this.writeInstances()
    this.flush()

    this.group.visible = false
    scene.add(this.group)
  }

  /** Rebuild every creature's segment + dust matrices/colours (scratch-only). */
  private writeInstances() {
    const reduced = config.reducedMotion
    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i]
      const base = i * SEGMENTS
      const dbase = i * PUFFS

      // Dormant (and not mid-dive): the whole body is underground - collapse it.
      if (c.phase === 'dormant') {
        for (let s = 0; s < SEGMENTS; s++) this.bodyMesh.setMatrixAt(base + s, this.ZERO)
        this.writeDust(c, dbase, reduced)
        continue
      }

      // Arc height factor: 0 at the ground, 1 at apex. Surfaced rides full height
      // with a gentle breathing bob; emerging/diving scale it by arc progress.
      const ease = c.phase === 'surfaced'
        ? 1
        : c.arc * c.arc * (3 - 2 * c.arc) // smoothstep on emerge/dive
      const slow = reduced ? 0.6 : 1
      const bob = c.phase === 'surfaced' ? Math.sin(this.t * 1.8 * slow + i) * 0.12 : 0

      const dirX = Math.cos(c.heading)
      const dirZ = Math.sin(c.heading)
      const half = (SEGMENTS - 1) / 2
      const pop = 1 + c.pop * 0.5 // quick scale-pop on tag

      for (let s = 0; s < SEGMENTS; s++) {
        // Position each segment along the heading; the body forms a sine arch so
        // the middle rides highest (worm bursting up out of the sand).
        const along = (s - half) * (c.length / SEGMENTS)
        const sx = c.x + dirX * along
        const sz = c.z + dirZ * along
        // Arch profile: 1 at centre segment, tapering to ~0 at the ends.
        const arch = Math.cos(((s - half) / (half + 0.5)) * (Math.PI / 2))
        const segGy = this.deps.groundY(sx, sz)
        const y = segGy + ease * (c.height * arch + bob)

        // Taper the end segments thinner (head/tail) and apply the tag pop.
        const taper = 0.6 + 0.4 * arch
        const scl = ease * taper * pop
        if (scl <= 0.001) {
          this.bodyMesh.setMatrixAt(base + s, this.ZERO)
          continue
        }
        // Orient the capsule's long axis (Y) toward the body curve: lean by the
        // local arch slope so segments flow head-to-tail along the arc.
        const lean = -Math.sin(((s - half) / (half + 0.5)) * (Math.PI / 2)) * 0.9 * ease
        this.mEuler.set(0, -c.heading, Math.PI / 2 + lean, 'XYZ')
        this.mQuat.setFromEuler(this.mEuler)
        this.mPos.set(sx, y, sz)
        this.mScl.set(scl, scl, scl)
        this.mtx.compose(this.mPos, this.mQuat, this.mScl)
        this.bodyMesh.setMatrixAt(base + s, this.mtx)
        // Tint brightens a touch toward the apex; the tag pop adds a calm glow
        // (never a flash - capped, and capped harder under reduced motion).
        const popGlow = c.pop * (reduced ? 0.15 : 0.35)
        this.scratch.copy(c.tint).multiplyScalar(0.8 + 0.2 * arch + popGlow)
        this.bodyMesh.setColorAt(base + s, this.scratch)
      }

      this.writeDust(c, dbase, reduced)
    }
  }

  /** Write this creature's dust-burst puffs (additive). Burst decays after emerge. */
  private writeDust(c: Burrower, dbase: number, reduced: boolean) {
    // Under reduced motion, render fewer puffs and dimmer (calm, never a flash).
    const livePuffs = reduced ? Math.max(2, (PUFFS / 2) | 0) : PUFFS
    if (c.burst <= 0.001) {
      for (let s = 0; s < PUFFS; s++) this.dustMesh.setMatrixAt(dbase + s, this.ZERO)
      return
    }
    const life = c.burst                // 1 -> 0
    const rise = (1 - life)             // 0 -> 1
    for (let s = 0; s < PUFFS; s++) {
      if (s >= livePuffs) { this.dustMesh.setMatrixAt(dbase + s, this.ZERO); continue }
      // Puffs ring out from the emergence point and drift up as the burst fades.
      const a = (s / PUFFS) * Math.PI * 2 + c.heading
      const spread = 0.6 + rise * 1.6
      const px = c.x + Math.cos(a) * spread
      const pz = c.z + Math.sin(a) * spread
      const py = c.gy + 0.3 + rise * 1.4
      const grow = (0.6 + rise * 1.3)
      this.mPos.set(px, py, pz)
      this.mScl.set(grow, grow, grow)
      this.mtx.compose(this.mPos, this.mQuat.identity(), this.mScl)
      this.dustMesh.setMatrixAt(dbase + s, this.mtx)
      // Dim ochre dust, fading out; reduced motion keeps it softer still.
      const bright = life * (reduced ? 0.18 : 0.35)
      this.scratch.copy(c.tint).multiplyScalar(bright)
      this.dustMesh.setColorAt(dbase + s, this.scratch)
    }
  }

  /** Mark instance buffers dirty after a batch of writes. */
  private flush() {
    for (const im of [this.bodyMesh, this.dustMesh]) {
      im.instanceMatrix.needsUpdate = true
      if (im.instanceColor) im.instanceColor.needsUpdate = true
    }
  }

  /** Relocate a creature's resting root somewhere within the spawn band of the
   *  player, picking a fresh heading. Seeded jitter, allocation-free. */
  private placeNearPlayer(c: Burrower) {
    const p = this.deps.playerPos()
    const ang = this.rnd() * Math.PI * 2
    const dist = BAND_MIN + this.rnd() * (BAND_MAX - BAND_MIN)
    c.x = p.x + Math.cos(ang) * dist
    c.z = p.z + Math.sin(ang) * dist
    c.gy = this.deps.groundY(c.x, c.z)
    c.heading = this.rnd() * Math.PI * 2
    c.height = 1.6 + this.rnd() * 1.2
    c.length = 1.5 + this.rnd() * 0.9
  }

  setZone(zone: Zone) {
    this.zone = zone
    this.group.visible = zone === 'mars'
  }

  update(dt: number) {
    const active = this.deps.zone() === 'mars'
    if (this.group.visible !== active) this.group.visible = active
    if (!active) return
    this.t += dt

    const p = this.deps.playerPos()
    const r2 = REACH * REACH

    for (let i = 0; i < this.creatures.length; i++) {
      const c = this.creatures[i]

      // Tag pop + dust burst always decay regardless of phase.
      if (c.pop > 0) c.pop = Math.max(0, c.pop - dt / POP_TIME)
      if (c.burst > 0) c.burst = Math.max(0, c.burst - dt / BURST_TIME)

      if (c.phase === 'dormant') {
        c.timer -= dt
        if (c.timer <= 0) {
          // Time to surface - but only if the player is in the spawn band and we
          // haven't hit the surfaced cap. Otherwise re-arm a short cooldown.
          if (this.surfacedCount >= this.maxSurfaced) { c.timer = 1.5 + this.rnd() * 2; continue }
          const dx = c.x - p.x, dz = c.z - p.z
          const d2 = dx * dx + dz * dz
          const inBand = d2 >= BAND_MIN * BAND_MIN && d2 <= BAND_MAX * BAND_MAX
          // If out of band, hop the resting root to a fresh in-band spot near the
          // player so the player always has something erupting nearby.
          if (!inBand) this.placeNearPlayer(c)
          c.phase = 'surfaced'
          c.arc = 0
          c.timer = EMERGE_TIME + SURFACE_TIME
          c.tagged = false
          c.burst = 1 // kick off the dust puff
          this.surfacedCount++
        }
        continue
      }

      if (c.phase === 'surfaced') {
        // Arc up over EMERGE_TIME, then hold; timer counts the whole surfaced span.
        c.timer -= dt
        const up = EMERGE_TIME + SURFACE_TIME - c.timer // time since emerge began
        c.arc = Math.min(1, up / EMERGE_TIME)

        // Proximity tag (3D): reward once, pop, and dive early.
        if (!c.tagged) {
          const dx = c.x - p.x
          const dy = (c.gy + c.height * 0.6) - p.y
          const dz = c.z - p.z
          if (dx * dx + dy * dy + dz * dz < r2) {
            c.tagged = true
            c.pop = 1
            this.deps.onReward(c.credits, c.xp, c.x, c.gy + c.height, c.z, `CRITTER +${c.credits}c`)
            c.phase = 'diving'
            c.timer = DIVE_TIME
          }
        }

        if (c.phase === 'surfaced' && c.timer <= 0) {
          c.phase = 'diving'
          c.timer = DIVE_TIME
        }
        continue
      }

      // diving: arc retreats back to 0, then go dormant on a fresh cooldown.
      c.timer -= dt
      c.arc = Math.max(0, c.timer / DIVE_TIME)
      if (c.timer <= 0) {
        c.phase = 'dormant'
        c.arc = 0
        c.timer = COOL_MIN + this.rnd() * COOL_VAR
        this.surfacedCount = Math.max(0, this.surfacedCount - 1)
      }
    }

    this.writeInstances()
    this.flush()
  }

  dispose() {
    this.bodyMesh.dispose()
    this.dustMesh.dispose()
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
