import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ so beacons sit on the floor. */
  groundY: (x: number, z: number) => number
  /** Called on a successful delivery: award credits + XP and pop a label at the dropoff. */
  onDeliver: (credits: number, xp: number, x: number, y: number, z: number) => void
  /** Show a short HUD banner ("CARGO PICKED UP — DELIVER!", "DELIVERED +Xc", "RUN EXPIRED"). */
  banner: (text: string) => void
}

type RunState = 'READY' | 'CARRYING' | 'DELIVERED' | 'EXPIRED'

/** Deterministic PRNG (copied from NeonFlora) so a run's coords come from a run counter. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * Cargo-run: a repeatable timed delivery job that gives traversal a purpose. Walk
 * into the cyan PICKUP beacon to grab a crate (it then hovers above the player); a
 * gold DROPOFF beacon lights up across the city with a tall light column - race
 * there before the countdown ends for a credit + XP payout scaled to speed. Earth-
 * gated, proximity-triggered (no key), shared geometry, pooled + disposed together.
 */
export class CargoRun implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private zone: Zone = 'earth'
  private t = 0

  private state: RunState = 'READY'
  private run = 0          // run counter, seeds the PRNG
  private delay = 0        // re-arm countdown after a DELIVERED / EXPIRED
  private timeLeft = 0     // seconds left in the current CARRYING run
  private timeTotal = 1    // duration of the current run, for the urgency ratio

  // Pickup beacon.
  private pickup = new THREE.Group()
  private pickupRing: THREE.Mesh
  private pickupCrate: THREE.Mesh
  private px = 0
  private pz = 0
  private pBaseY = 0

  // Dropoff beacon.
  private dropoff = new THREE.Group()
  private dropColumnMat: THREE.MeshBasicMaterial
  private dropRing: THREE.Mesh
  private dropRingMat: THREE.MeshBasicMaterial
  private dx = 0
  private dz = 0
  private dBaseY = 0

  // Crate that follows the player while CARRYING.
  private carried: THREE.Mesh

  // Tuning.
  private readonly pickReach = 3      // grab radius (XZ)
  private readonly dropReach = 3.5    // deliver radius (XZ)
  private readonly baseCredits = 60
  private readonly baseXp = 30
  private readonly rearmDelay = 2.5   // pause between runs

  // Pre-allocated scratch so the per-frame urgency tint never allocates.
  private scratch = new THREE.Color()
  private readonly cyan = new THREE.Color(0x49e0ff)
  private readonly gold = new THREE.Color(0xffd24a)
  private readonly hot = new THREE.Color(0xff5a3c)

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    // Shared geometry across both beacons + the carried crate.
    const padGeo = this.ownG(new THREE.CylinderGeometry(1.4, 1.6, 0.25, 20))
    const ringGeo = this.ownG(new THREE.TorusGeometry(1.0, 0.08, 8, 24))
    const crateGeo = this.ownG(new THREE.BoxGeometry(0.9, 0.9, 0.9))
    const columnGeo = this.ownG(new THREE.CylinderGeometry(0.6, 0.6, 40, 12, 1, true))

    const padMat = this.own(new THREE.MeshBasicMaterial({ color: 0x121826, fog: true }))

    // --- Pickup beacon (cyan): pad + ring + floating crate above it. ---
    const pickPad = new THREE.Mesh(padGeo, padMat)
    pickPad.position.y = 0.12
    this.pickup.add(pickPad)

    const pickRingMat = this.own(new THREE.MeshBasicMaterial({ color: this.cyan, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.pickupRing = new THREE.Mesh(ringGeo, pickRingMat)
    this.pickupRing.rotation.x = Math.PI / 2
    this.pickupRing.position.y = 0.3
    this.pickup.add(this.pickupRing)

    const pickCrateMat = this.own(new THREE.MeshBasicMaterial({ color: this.cyan, fog: false }))
    this.pickupCrate = new THREE.Mesh(crateGeo, pickCrateMat)
    this.pickupCrate.position.y = 2.4
    this.pickup.add(this.pickupCrate)
    this.group.add(this.pickup)

    // --- Dropoff beacon (gold): pad + ring + tall translucent light column. ---
    const dropPad = new THREE.Mesh(padGeo, padMat)
    dropPad.position.y = 0.12
    this.dropoff.add(dropPad)

    this.dropRingMat = this.own(new THREE.MeshBasicMaterial({ color: this.gold, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.dropRing = new THREE.Mesh(ringGeo, this.dropRingMat)
    this.dropRing.rotation.x = Math.PI / 2
    this.dropRing.position.y = 0.3
    this.dropoff.add(this.dropRing)

    this.dropColumnMat = this.own(new THREE.MeshBasicMaterial({ color: this.gold, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const column = new THREE.Mesh(columnGeo, this.dropColumnMat)
    column.position.y = 20
    this.dropoff.add(column)
    this.dropoff.visible = false
    this.group.add(this.dropoff)

    // --- Crate that hovers above the player while carrying. ---
    const carriedMat = this.own(new THREE.MeshBasicMaterial({ color: this.cyan, fog: false }))
    this.carried = new THREE.Mesh(crateGeo, carriedMat)
    this.carried.visible = false
    this.group.add(this.carried)

    this.armRun()

    this.group.visible = false
    scene.add(this.group)
  }

  /** Roll a fresh pickup + dropoff for the current run counter and reset to READY. */
  private armRun() {
    const half = config.world.half * 0.6
    const rnd = mulberry32(0x6ca40 + this.run * 2654435761)
    this.px = (rnd() * 2 - 1) * half
    this.pz = (rnd() * 2 - 1) * half
    // Re-roll the dropoff until it sits a good distance from the pickup.
    let ddx = 0, ddz = 0, dist = 0, guard = 0
    do {
      this.dx = (rnd() * 2 - 1) * half
      this.dz = (rnd() * 2 - 1) * half
      ddx = this.dx - this.px
      ddz = this.dz - this.pz
      dist = Math.hypot(ddx, ddz)
    } while (dist < 80 && guard++ < 32)

    this.pBaseY = this.deps.groundY(this.px, this.pz)
    this.dBaseY = this.deps.groundY(this.dx, this.dz)
    this.pickup.position.set(this.px, this.pBaseY, this.pz)
    this.dropoff.position.set(this.dx, this.dBaseY, this.dz)

    this.state = 'READY'
    this.pickup.visible = true
    this.dropoff.visible = false
    this.carried.visible = false
    this.timeLeft = 0
  }

  setZone(zone: Zone) {
    this.zone = zone
    const onEarth = zone === 'earth'
    this.group.visible = onEarth
    // Leaving Earth abandons any in-flight run; restore a clean READY on return.
    if (!onEarth && this.state !== 'READY') { this.run++; this.armRun() }
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt
    const f = this.deps.focus()

    // Re-arm delay between runs (after DELIVERED / EXPIRED).
    if (this.delay > 0) {
      this.delay = Math.max(0, this.delay - dt)
      if (this.delay <= 0) { this.run++; this.armRun() }
      return
    }

    const pulse = 0.5 + 0.5 * Math.sin(this.t * 3)

    if (this.state === 'READY') {
      // Pickup beacon: bobbing/spinning crate, pulsing ring.
      this.pickupCrate.position.y = 2.4 + Math.sin(this.t * 1.6) * 0.25
      this.pickupCrate.rotation.y += dt * 1.2
      this.pickupRing.rotation.z += dt * 0.9
      this.pickupRing.scale.setScalar(1 + pulse * 0.08)

      const gx = this.px - f.x, gz = this.pz - f.z
      if (gx * gx + gz * gz < this.pickReach * this.pickReach) {
        // Grab: light the dropoff, start a distance-scaled countdown.
        const dist = Math.hypot(this.dx - this.px, this.dz - this.pz)
        this.timeTotal = Math.max(20, Math.min(45, 18 + dist * 0.12))
        this.timeLeft = this.timeTotal
        this.state = 'CARRYING'
        this.pickup.visible = false
        this.dropoff.visible = true
        this.carried.visible = true
        this.deps.banner('CARGO PICKED UP — DELIVER!')
      }
      return
    }

    if (this.state === 'CARRYING') {
      // Crate follows the player, hovering ~2.5 above with a bob + spin.
      this.carried.position.set(f.x, f.y + 2.5 + Math.sin(this.t * 2.2) * 0.15, f.z)
      this.carried.rotation.y += dt * 1.6

      this.timeLeft = Math.max(0, this.timeLeft - dt)
      // Urgency: as time runs low the gold column shifts hot and pulses faster.
      const ratio = this.timeLeft / this.timeTotal // 1 -> 0
      const urgency = 1 - ratio // 0 -> 1
      const flashSpeed = 3 + urgency * urgency * 12
      const flash = 0.5 + 0.5 * Math.sin(this.t * flashSpeed)
      this.scratch.copy(this.gold).lerp(this.hot, urgency * urgency)
      this.dropColumnMat.color.copy(this.scratch)
      this.dropColumnMat.opacity = 0.14 + flash * (0.12 + urgency * 0.22)
      this.dropRingMat.color.copy(this.scratch)
      this.dropRingMat.opacity = 0.55 + flash * 0.35
      this.dropRing.rotation.z += dt * (0.9 + urgency * 2)
      this.dropRing.scale.setScalar(1 + flash * 0.12)

      // Deliver?
      const dx = this.dx - f.x, dz = this.dz - f.z
      if (dx * dx + dz * dz < this.dropReach * this.dropReach) {
        const speedBonus = Math.round(this.baseCredits * 2 * ratio)
        const credits = this.baseCredits + speedBonus
        const xp = this.baseXp + Math.round(this.baseXp * ratio)
        this.deps.onDeliver(credits, xp, this.dx, this.dBaseY + 2, this.dz)
        this.deps.banner(`DELIVERED +${credits}c`)
        this.state = 'DELIVERED'
        this.dropoff.visible = false
        this.carried.visible = false
        this.delay = this.rearmDelay
        return
      }

      // Out of time: drop it, re-arm shortly.
      if (this.timeLeft <= 0) {
        this.deps.banner('RUN EXPIRED')
        this.state = 'EXPIRED'
        this.dropoff.visible = false
        this.carried.visible = false
        this.delay = this.rearmDelay
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
