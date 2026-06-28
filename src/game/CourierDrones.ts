import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'

interface Deps {
  /** Player focus, so the network buzzes around wherever you are in the city. */
  focus: () => THREE.Vector3
}

interface Drone {
  pos: THREE.Vector3
  target: THREE.Vector3
  yaw: number
  speed: number
  dwell: number // >0 = paused at a waypoint, counting down
  blink: number // nav-light phase offset
  bank: number // eased roll into turns
  rotorSpin: number // accumulated rotor angle (shared across both discs)
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
 *
 * Rendered with one InstancedMesh per part across the whole fleet (every drone
 * shares geometry + material), so the network draws in a handful of calls instead
 * of ~6 per drone. Per-frame matrices are written via setMatrixAt using a single
 * scratch transform (no per-frame heap allocation). The nav-light blink and cargo
 * glow pulse - which used to mutate per-drone material opacity - are reproduced via
 * per-instance color: these are additive glows, so scaling instance brightness is
 * visually identical to scaling opacity (additive contribution = color * opacity).
 */
export class CourierDrones implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private drones: Drone[] = []
  private zone: Zone = 'earth'
  private t = 0
  private rnd = mulberry32(0x0c0d1a)
  private count: number

  // One InstancedMesh per part; arms/rotors carry two instances per drone.
  private body!: THREE.InstancedMesh
  private arm!: THREE.InstancedMesh
  private cargo!: THREE.InstancedMesh
  private rotor!: THREE.InstancedMesh // 2 per drone
  private nav!: THREE.InstancedMesh

  // Pre-allocated scratch reused every frame (no per-frame heap allocation).
  private dir = new THREE.Vector3()
  private m = new THREE.Matrix4()
  private mLocal = new THREE.Matrix4()
  private pos = new THREE.Vector3()
  private quat = new THREE.Quaternion()
  private euler = new THREE.Euler()
  private scl = new THREE.Vector3(1, 1, 1)
  private rotorEuler = new THREE.Euler()
  private rotorQuat = new THREE.Quaternion()
  private rotorPos = new THREE.Vector3()
  private col = new THREE.Color()

  // Static local offsets, baked once. Rotor discs share the spin angle.
  private static ROTOR_OFFSETS = [-0.75, 0.75]

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }
  private ownMesh(im: THREE.InstancedMesh) { im.frustumCulled = false; this.group.add(im) }

  constructor(scene: THREE.Scene, private deps: Deps) {
    const low = config.tier.name === 'low'
    const count = low ? 4 : 8
    this.count = count

    // Shared geometries reused across every drone.
    const bodyGeo = this.ownG(new THREE.BoxGeometry(1.1, 0.4, 0.7))
    const cargoGeo = this.ownG(new THREE.BoxGeometry(0.6, 0.6, 0.6))
    const armGeo = this.ownG(new THREE.BoxGeometry(1.5, 0.06, 0.1))
    const rotorGeo = this.ownG(new THREE.CircleGeometry(0.5, 12))
    const navGeo = this.ownG(new THREE.SphereGeometry(0.1, 8, 6))

    // Shared materials. Body is lit metal; cargo + rotors + nav are additive glows.
    // Cargo + nav use per-instance color to carry their pulse/blink (see class doc),
    // so their base color is white (1,1,1) and the original tint is folded into the
    // instanceColor we write each frame.
    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x2a3550, metalness: 0.7, roughness: 0.4, emissive: 0x0a1830, emissiveIntensity: 0.4 }))
    const cargoMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const rotorMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9fe9ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide }))
    const navMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))

    this.body = new THREE.InstancedMesh(bodyGeo, bodyMat, count)
    this.arm = new THREE.InstancedMesh(armGeo, bodyMat, count)
    this.cargo = new THREE.InstancedMesh(cargoGeo, cargoMat, count)
    this.rotor = new THREE.InstancedMesh(rotorGeo, rotorMat, count * 2)
    this.nav = new THREE.InstancedMesh(navGeo, navMat, count)
    this.body.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.arm.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.cargo.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.rotor.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.nav.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

    this.ownMesh(this.body)
    this.ownMesh(this.arm)
    this.ownMesh(this.cargo)
    this.ownMesh(this.rotor)
    this.ownMesh(this.nav)

    for (let i = 0; i < count; i++) {
      const pos = new THREE.Vector3()
      this.scatter(pos)
      const target = new THREE.Vector3()
      this.scatter(target)
      this.drones.push({
        pos, target,
        yaw: 0,
        speed: 6 + this.rnd() * 6,
        dwell: 0,
        blink: this.rnd() * 6.28,
        bank: 0,
        rotorSpin: 0,
      })
    }

    // Seed per-instance colors so the static parts read correctly on frame 0.
    // Cargo (0xffb347) and nav (0xff4d6d) carry their tint via instanceColor.
    for (let i = 0; i < count; i++) {
      this.cargo.setColorAt(i, this.col.setHex(0xffb347))
      this.nav.setColorAt(i, this.col.setHex(0xff4d6d))
    }
    if (this.cargo.instanceColor) this.cargo.instanceColor.needsUpdate = true
    if (this.nav.instanceColor) this.nav.instanceColor.needsUpdate = true

    // Write initial transforms so the fleet is placed before the first update.
    this.writeMatrices()

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

  /**
   * Compose every instance matrix from the current drone state. Positions, yaw,
   * bank and rotor spin are already baked into drone state by update(); this only
   * assembles the transforms. Pure scratch reuse - no allocation.
   */
  private writeMatrices() {
    const ro = CourierDrones.ROTOR_OFFSETS
    for (let i = 0; i < this.count; i++) {
      const d = this.drones[i]
      // Drone group transform: position (with bob), yaw, bank roll.
      const bob = Math.sin(this.t * 2 + d.blink) * 0.15
      this.pos.set(d.pos.x, d.pos.y + bob, d.pos.z)
      this.euler.set(0, d.yaw, d.bank, 'XYZ')
      this.quat.setFromEuler(this.euler)
      this.m.compose(this.pos, this.quat, this.scl)

      // Body + arm sit at the group origin.
      this.body.setMatrixAt(i, this.m)
      this.arm.setMatrixAt(i, this.m)

      // Cargo box slung underneath at (0, -0.55, 0) in local space.
      this.mLocal.makeTranslation(0, -0.55, 0)
      this.mLocal.premultiply(this.m)
      this.cargo.setMatrixAt(i, this.mLocal)

      // Nav light on the tail at (0, 0.05, -0.45).
      this.mLocal.makeTranslation(0, 0.05, -0.45)
      this.mLocal.premultiply(this.m)
      this.nav.setMatrixAt(i, this.mLocal)

      // Two rotor discs: laid flat (rotation.x = -PI/2) and spinning (rotation.z).
      this.rotorEuler.set(-Math.PI / 2, 0, d.rotorSpin, 'XYZ')
      this.rotorQuat.setFromEuler(this.rotorEuler)
      for (let k = 0; k < 2; k++) {
        this.rotorPos.set(ro[k], 0.18, 0)
        this.mLocal.compose(this.rotorPos, this.rotorQuat, this.scl)
        this.mLocal.premultiply(this.m)
        this.rotor.setMatrixAt(i * 2 + k, this.mLocal)
      }
    }
    this.body.instanceMatrix.needsUpdate = true
    this.arm.instanceMatrix.needsUpdate = true
    this.cargo.instanceMatrix.needsUpdate = true
    this.rotor.instanceMatrix.needsUpdate = true
    this.nav.instanceMatrix.needsUpdate = true
  }

  update(dt: number) {
    // Drive visibility from the zone each frame so it's correct at startup too
    // (setZone only fires on a zone *change*, and you begin on Earth).
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return
    this.t += dt

    let navDirty = false
    let cargoDirty = false

    for (let i = 0; i < this.count; i++) {
      const d = this.drones[i]
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
          turn = yaw - d.yaw
          while (turn > Math.PI) turn -= Math.PI * 2
          while (turn < -Math.PI) turn += Math.PI * 2
          d.yaw = yaw
        }
      }
      // Ease bank toward the current turn rate.
      d.bank += (THREE.MathUtils.clamp(turn * 4, -0.5, 0.5) - d.bank) * Math.min(1, dt * 4)
      // Rotors spin.
      d.rotorSpin += dt * 40

      // Nav light blinks; cargo glow softly pulses. Reproduced as instance color
      // brightness (additive glow -> color*scale matches the old color*opacity).
      const navB = Math.sin(this.t * 6 + d.blink) > 0.4 ? 1 : 0.1
      this.col.setHex(0xff4d6d).multiplyScalar(navB)
      this.nav.setColorAt(i, this.col)
      navDirty = true

      // Old cargo animated its opacity to exactly this value (overriding the 0.85
      // baseline); now base opacity is 1 and the same value drives instance
      // brightness, so the additive result is identical.
      const cargoB = 0.7 + (0.5 + 0.5 * Math.sin(this.t * 3 + d.blink)) * 0.2
      this.col.setHex(0xffb347).multiplyScalar(cargoB)
      this.cargo.setColorAt(i, this.col)
      cargoDirty = true
    }

    this.writeMatrices()
    if (navDirty && this.nav.instanceColor) this.nav.instanceColor.needsUpdate = true
    if (cargoDirty && this.cargo.instanceColor) this.cargo.instanceColor.needsUpdate = true
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    this.body.dispose()
    this.arm.dispose()
    this.cargo.dispose()
    this.rotor.dispose()
    this.nav.dispose()
  }
}
