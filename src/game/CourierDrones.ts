import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so the network buzzes around wherever you are in the city. */
  focus: () => THREE.Vector3
}

interface Drone {
  group: THREE.Group
  cargo: THREE.Mesh
  rotors: THREE.Object3D[]
  nav: THREE.Mesh
  pos: THREE.Vector3
  target: THREE.Vector3
  speed: number
  dwell: number // >0 = paused at a waypoint, counting down
  blink: number // nav-light phase offset
  bank: number // eased roll into turns
}

/** Deterministic PRNG so routes/layout are identical each load. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/**
 * A small fleet of autonomous courier drones that zip point-to-point through the
 * Earth city at mid-height, each slinging a glowing cargo box under blinking nav
 * lights and spinning rotors. Pure ambient logistics life - additive accents, no
 * colliders, no gameplay. Shared geos/mats, pooled + Earth-gated, disposed together.
 */
export class CourierDrones implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private drones: Drone[] = []
  private zone: Zone = 'earth'
  private t = 0
  private rnd = mulberry32(0x0c0d1a)
  // Pre-allocated scratch reused every frame (no per-frame heap allocation).
  private dir = new THREE.Vector3()

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const count = low ? 4 : 8

    // Shared geometries reused across every drone.
    const bodyGeo = this.ownG(new THREE.BoxGeometry(1.1, 0.4, 0.7))
    const cargoGeo = this.ownG(new THREE.BoxGeometry(0.6, 0.6, 0.6))
    const armGeo = this.ownG(new THREE.BoxGeometry(1.5, 0.06, 0.1))
    const rotorGeo = this.ownG(new THREE.CircleGeometry(0.5, 12))
    const navGeo = this.ownG(new THREE.SphereGeometry(0.1, 8, 6))

    // Shared materials. Body is lit metal; cargo + rotors + nav are additive glows.
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.7, roughness: 0.4, emissive: 0x0a1830, emissiveIntensity: 0.4 }))
    const cargoMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const rotorMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9fe9ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide }))
    const navMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff4d6d, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))

    for (let i = 0; i < count; i++) {
      const group = new THREE.Group()
      const body = new THREE.Mesh(bodyGeo, bodyMat); group.add(body)
      const arm = new THREE.Mesh(armGeo, bodyMat); group.add(arm)
      // Slung cargo box underneath, glowing.
      const cargo = new THREE.Mesh(cargoGeo, cargoMat); cargo.position.set(0, -0.55, 0); group.add(cargo)
      // Two spinning rotor discs out on the arm.
      const rotors: THREE.Object3D[] = []
      for (const sx of [-0.75, 0.75]) {
        const r = new THREE.Mesh(rotorGeo, rotorMat); r.rotation.x = -Math.PI / 2; r.position.set(sx, 0.18, 0); group.add(r); rotors.push(r)
      }
      // A tiny blinking nav light on the tail.
      const nav = new THREE.Mesh(navGeo, navMat); nav.position.set(0, 0.05, -0.45); group.add(nav)

      const pos = new THREE.Vector3()
      this.scatter(pos)
      const target = new THREE.Vector3()
      this.scatter(target)
      group.position.copy(pos)

      this.group.add(group)
      this.drones.push({
        group, cargo, rotors, nav,
        pos, target,
        speed: 6 + this.rnd() * 6,
        dwell: 0,
        blink: this.rnd() * 6.28,
        bank: 0,
      })
    }

    this.group.visible = false
    scene.add(this.group)
  }

  /** Pick a random mid-height waypoint within the city, writing into `out`. */
  private scatter(out: THREE.Vector3) {
    const reach = config.world.half * 0.8
    out.set((this.rnd() * 2 - 1) * reach, 8 + this.rnd() * 14, (this.rnd() * 2 - 1) * reach)
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

    for (const d of this.drones) {
      let turn = 0
      if (d.dwell > 0) {
        // Paused at a waypoint, then pick a new destination + height.
        d.dwell -= dt
        if (d.dwell <= 0) this.scatter(d.target)
      } else {
        this.dir.subVectors(d.target, d.pos)
        const dist = this.dir.length()
        if (dist < 1.2) {
          d.dwell = 0.5 + this.rnd() * 1.0
        } else {
          this.dir.multiplyScalar(1 / dist) // normalize without allocating
          const step = Math.min(dist, d.speed * dt)
          d.pos.addScaledVector(this.dir, step)
          // Face the direction of travel; remember desired yaw to bank into turns.
          const yaw = Math.atan2(this.dir.x, this.dir.z)
          turn = yaw - d.group.rotation.y
          while (turn > Math.PI) turn -= Math.PI * 2
          while (turn < -Math.PI) turn += Math.PI * 2
          d.group.rotation.y = yaw
        }
      }
      // Gentle bob; ease bank toward the current turn rate.
      const bob = Math.sin(this.t * 2 + d.blink) * 0.15
      d.group.position.set(d.pos.x, d.pos.y + bob, d.pos.z)
      d.bank += (THREE.MathUtils.clamp(turn * 4, -0.5, 0.5) - d.bank) * Math.min(1, dt * 4)
      d.group.rotation.z = d.bank
      // Rotors spin; nav light blinks; cargo glow softly pulses.
      for (const r of d.rotors) r.rotation.z += dt * 40
      const navMat = d.nav.material as THREE.MeshBasicMaterial
      navMat.opacity = Math.sin(this.t * 6 + d.blink) > 0.4 ? 1 : 0.1
      const cargoMat = d.cargo.material as THREE.MeshBasicMaterial
      cargoMat.opacity = 0.7 + (0.5 + 0.5 * Math.sin(this.t * 3 + d.blink)) * 0.2
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
  }
}
