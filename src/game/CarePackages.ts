import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player world position. */
  focus: () => THREE.Vector3
  /** Sampled ground height at an XZ so a crate lands on the floor. */
  groundY: (x: number, z: number) => number
  /** Called when a landed crate is claimed: award credits + XP and pop a label. */
  onCollect: (x: number, y: number, z: number, credits: number, xp: number) => void
  /** Show a short HUD banner ("SUPPLY DROP INBOUND", "SUPPLY CLAIMED"). */
  banner: (text: string) => void
}

type DropState = 'IDLE' | 'INBOUND' | 'FALLING' | 'LANDED' | 'CLAIMED' | 'EXPIRED'

/**
 * Care-packages: an intermittent "race to the drop" loop. Every so often a supply
 * crate parachutes from the sky onto the city under a tall light beam + banner;
 * sprint to it before its ~20s claim timer runs out for a credit + XP reward. The
 * beam pulses faster as time runs low. Earth-gated, one crate at a time, a single
 * pooled rig (crate + chute + beam + ring) repositioned per drop, disposed together.
 */
export class CarePackages implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private zone: Zone = 'earth'
  private t = 0

  private state: DropState = 'IDLE'
  private cooldown = 8        // seconds until the first drop / between drops
  private claimLeft = 0       // seconds left to reach a LANDED crate
  private fallY = 0           // current crate altitude while FALLING
  private startY = 0          // spawn altitude (sky)
  private landY = 0           // target ground altitude

  // Pooled rig.
  private rig = new THREE.Group()
  private crate: THREE.Mesh
  private chute: THREE.Mesh
  private beam: THREE.Mesh
  private beamMat: THREE.MeshBasicMaterial
  private ring: THREE.Mesh
  private ringMat: THREE.MeshBasicMaterial
  private cx = 0
  private cz = 0

  // Tuning.
  private readonly spawnHeight = 70   // crate altitude at INBOUND
  private readonly fallSpeed = 9      // descent rate under the chute
  private readonly reach = 3.5        // claim radius (3D)
  private readonly claimTime = 20     // seconds to grab a landed crate
  private readonly credits = 90
  private readonly xp = 45

  // Pre-allocated scratch so the per-frame urgency tint never allocates.
  private scratch = new THREE.Color()
  private readonly gold = new THREE.Color(0xffd24a)
  private readonly hot = new THREE.Color(0xff5a3c)

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const crateGeo = this.ownG(new THREE.BoxGeometry(1.4, 1.4, 1.4))
    const chuteGeo = this.ownG(new THREE.SphereGeometry(2.0, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2))
    const beamGeo = this.ownG(new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1, true))
    const ringGeo = this.ownG(new THREE.TorusGeometry(1.6, 0.1, 8, 24))

    // Crate body.
    const crateMat = this.own(new THREE.MeshBasicMaterial({ color: this.gold, fog: false }))
    this.crate = new THREE.Mesh(crateGeo, crateMat)
    this.rig.add(this.crate)

    // Parachute canopy above the crate.
    const chuteMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: 0.85, side: THREE.DoubleSide, fog: false }))
    this.chute = new THREE.Mesh(chuteGeo, chuteMat)
    this.chute.position.y = 3.2
    this.rig.add(this.chute)

    // Tall vertical light beam from the crate down to the ground (a unit cylinder
    // scaled in Y per state so it always spans crate -> floor; origin at its base).
    this.beamMat = this.own(new THREE.MeshBasicMaterial({ color: this.gold, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    this.beam = new THREE.Mesh(beamGeo, this.beamMat)
    this.beam.geometry.translate(0, 0.5, 0) // base at y=0 so scale.y == height
    this.rig.add(this.beam)

    // Spinning ground ring, shown when LANDED.
    this.ringMat = this.own(new THREE.MeshBasicMaterial({ color: this.gold, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    this.ring = new THREE.Mesh(ringGeo, this.ringMat)
    this.ring.rotation.x = Math.PI / 2
    this.rig.add(this.ring)

    this.rig.visible = false
    this.group.add(this.rig)

    this.group.visible = false
    scene.add(this.group)
  }

  /** Pick a fresh drop point near the player and arm an INBOUND crate. */
  private beginDrop() {
    const f = this.deps.focus()
    const reach = config.world.half * 0.5
    this.cx = THREE.MathUtils.clamp(f.x + (Math.random() * 2 - 1) * reach, -config.world.half, config.world.half)
    this.cz = THREE.MathUtils.clamp(f.z + (Math.random() * 2 - 1) * reach, -config.world.half, config.world.half)
    this.landY = this.deps.groundY(this.cx, this.cz)
    this.startY = this.landY + this.spawnHeight
    this.fallY = this.startY

    this.rig.position.set(this.cx, this.startY, this.cz)
    this.crate.position.y = 0
    this.chute.visible = true
    this.ring.visible = false
    this.rig.visible = true
    this.state = 'INBOUND'
    this.deps.banner('SUPPLY DROP INBOUND')
  }

  /** Hide the rig and drop back into IDLE with a fresh cooldown. */
  private reset() {
    this.rig.visible = false
    this.state = 'IDLE'
    this.cooldown = 30 + Math.random() * 20
  }

  setZone(zone: Zone) {
    this.zone = zone
    const onEarth = zone === 'earth'
    this.group.visible = onEarth
    // Leaving Earth abandons any in-flight drop; come back to a clean IDLE cooldown.
    if (!onEarth && this.state !== 'IDLE') this.reset()
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt

    // Always keep the beam spanning the full crate -> ground gap (origin at base).
    const setBeam = (height: number) => {
      this.beam.position.y = -height
      this.beam.scale.y = Math.max(0.01, height)
    }

    if (this.state === 'IDLE') {
      this.cooldown -= dt
      if (this.cooldown <= 0) this.beginDrop()
      return
    }

    if (this.state === 'INBOUND') {
      // Brief beat at altitude with the chute open + beam down to the ground, then fall.
      setBeam(this.startY - this.landY)
      this.beamMat.opacity = 0.18 + 0.06 * (0.5 + 0.5 * Math.sin(this.t * 3))
      this.crate.rotation.y += dt * 0.6
      this.state = 'FALLING'
      return
    }

    if (this.state === 'FALLING') {
      this.fallY = Math.max(this.landY, this.fallY - this.fallSpeed * dt)
      // Gentle sway under the canopy.
      const sway = Math.sin(this.t * 1.8) * 0.6
      this.rig.position.set(this.cx + sway, this.fallY, this.cz + Math.cos(this.t * 1.6) * 0.6)
      this.chute.rotation.z = Math.sin(this.t * 1.8) * 0.12
      this.crate.rotation.y += dt * 0.6
      setBeam(this.fallY - this.landY)
      this.beamMat.opacity = 0.18 + 0.06 * (0.5 + 0.5 * Math.sin(this.t * 3))
      if (this.fallY <= this.landY) {
        // Touch down: drop the chute, light the ground ring, start the claim timer.
        this.rig.position.set(this.cx, this.landY, this.cz)
        this.chute.visible = false
        this.ring.visible = true
        this.ring.position.y = 0.2
        this.state = 'LANDED'
        this.claimLeft = this.claimTime
      }
      return
    }

    if (this.state === 'LANDED') {
      this.claimLeft = Math.max(0, this.claimLeft - dt)
      const ratio = this.claimLeft / this.claimTime // 1 -> 0
      const urgency = 1 - ratio
      // Beam + ring shift hot and pulse faster as the timer runs low.
      const flashSpeed = 3 + urgency * urgency * 14
      const flash = 0.5 + 0.5 * Math.sin(this.t * flashSpeed)
      this.scratch.copy(this.gold).lerp(this.hot, urgency * urgency)
      this.beamMat.color.copy(this.scratch)
      this.beamMat.opacity = 0.18 + flash * (0.12 + urgency * 0.28)
      this.ringMat.color.copy(this.scratch)
      this.ringMat.opacity = 0.55 + flash * 0.4
      this.ring.rotation.z += dt * (1.0 + urgency * 2.5)
      this.ring.scale.setScalar(1 + flash * 0.12)
      this.crate.position.y = 0.9 + Math.sin(this.t * 2.0) * 0.12
      this.crate.rotation.y += dt * 0.8
      // Keep the beam spanning the (small) crate -> floor gap.
      setBeam(this.startY - this.landY)

      const f = this.deps.focus()
      const dx = this.cx - f.x, dy = (this.landY + this.crate.position.y) - f.y, dz = this.cz - f.z
      if (dx * dx + dy * dy + dz * dz < this.reach * this.reach) {
        this.deps.onCollect(this.cx, this.landY + 2, this.cz, this.credits, this.xp)
        this.deps.banner('SUPPLY CLAIMED')
        this.state = 'CLAIMED'
        this.reset()
        return
      }
      if (this.claimLeft <= 0) {
        this.state = 'EXPIRED'
        this.reset()
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
