import * as THREE from 'three'
import { config } from './config'
import type { GameSystem } from './System'
import type { Zone } from './types'
import type { Capturable } from './Game'

/**
 * Rogue sentry drones that patrol the city, lock onto the player when near, and
 * chase to menace them - a little combat stakes during the Earth roam. They
 * register as Capturables, so the existing net/missiles destroy them for a bounty
 * with no special-casing. In contact range a drone does a quick zap-lunge that
 * knocks the player back (onZap impulse), then recoils. Earth only; respawns.
 *
 * Rendering: the fleet is instanced per part. Every drone shares one InstancedMesh
 * per part (body / shell / eye / scan / thruster), so the whole fleet is ~5 draw
 * calls instead of ~6 per drone. Per-frame each drone's world matrix is composed
 * once and combined with each part's static local matrix via setMatrixAt (scratch
 * reused, no per-frame heap allocation). Inactive drones are hidden by writing a
 * zero-scale matrix. The eye's per-drone glow pulse rides on per-instance color
 * (setColorAt), which MeshBasicMaterial multiplies against its white base.
 */

interface Deps {
  /** Player position (chase + detection target). */
  focus: () => THREE.Vector3
  /** Ground height under a point (hover height + respawn placement). */
  groundY: (x: number, z: number) => number
  /** Knockback impulse applied to the player on a completed zap (away from drone). */
  onZap: (kx: number, kz: number, ky: number) => void
}

type DroneState = 'patrol' | 'chase'

interface Drone {
  index: number // instance slot
  cap: Capturable
  eyeColor: THREE.Color // per-drone eye glow, written to the eye InstancedMesh
  pos: THREE.Vector3 // shared with cap.position
  vel: THREE.Vector3
  home: THREE.Vector3
  state: DroneState
  bob: number // bob phase
  spin: number // eye/scanner spin phase
  glow: number // current eye glow (eased toward target)
  zapCd: number // >0 while the zap is on cooldown
  recoil: number // >0 while recoiling after a zap
  destroyed: boolean
  respawn: number // >0 while destroyed, counting down to respawn
  visible: boolean // currently rendered (drives zero-scale hide)
}

const AREA = 130 // drones home within a +/-AREA square around origin
const DETECT = 26
const CONTACT = 3.5
const CHASE_SPEED = 11
const PATROL_SPEED = 3
const HOVER = 4 // rest height above local ground

export class HostileDrones implements GameSystem {
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private drones: Drone[] = []
  private zone: Zone = 'earth'

  // Instanced parts. One InstancedMesh per part type; thrusters pack 2 per drone.
  private bodyMesh!: THREE.InstancedMesh
  private shellMesh!: THREE.InstancedMesh
  private eyeMesh!: THREE.InstancedMesh
  private scanMesh!: THREE.InstancedMesh
  private thrusterMesh!: THREE.InstancedMesh

  // Static per-part local offsets (relative to the drone group). Built once.
  private shellLocal = new THREE.Matrix4()
  private eyeLocal = new THREE.Matrix4()
  private scanLocal = new THREE.Matrix4()
  private thrusterLocalL = new THREE.Matrix4()
  private thrusterLocalR = new THREE.Matrix4()

  // scratch - reused every frame, no per-frame allocation
  private toPlayer = new THREE.Vector3()
  private toHome = new THREE.Vector3()
  private desired = new THREE.Vector3()
  private mWorld = new THREE.Matrix4() // drone group world matrix
  private mPart = new THREE.Matrix4() // world * local, per part
  private qScratch = new THREE.Quaternion()
  private eScratch = new THREE.Euler()
  private sUnit = new THREE.Vector3(1, 1, 1)
  private mHidden = new THREE.Matrix4().makeScale(0, 0, 0)

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  constructor(scene: THREE.Scene, capturables: Capturable[], private deps: Deps) {
    const n = config.tier.name === 'low' ? 3 : 5

    // --- shared geometry/materials (built once, reused across drones) ---
    const bodyGeo = this.ownG(new THREE.IcosahedronGeometry(0.6, 0))
    const shellGeo = this.ownG(new THREE.TorusGeometry(0.62, 0.07, 6, 16))
    const eyeGeo = this.ownG(new THREE.SphereGeometry(0.18, 10, 8))
    const scanGeo = this.ownG(new THREE.RingGeometry(0.7, 0.86, 20))
    const thrusterGeo = this.ownG(new THREE.SphereGeometry(0.09, 6, 5))

    const bodyMat = this.own(new THREE.MeshStandardMaterial({ color: 0x1a1d24, metalness: 0.85, roughness: 0.35, emissive: 0x140404, emissiveIntensity: 0.4 }))
    const shellMat = this.own(new THREE.MeshStandardMaterial({ color: 0x3a3f4a, metalness: 0.7, roughness: 0.4 }))
    // Eye base is white so the per-instance color (the glow pulse) shows through unmodified.
    const eyeMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }))
    const scanMat = this.own(new THREE.MeshBasicMaterial({ color: 0xff5a2a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }))
    const thrusterMat = this.own(new THREE.MeshBasicMaterial({ color: 0xffae3a, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))

    // Static local transforms, matching the original per-mesh setup.
    this.shellLocal.makeRotationX(Math.PI / 2)
    this.eyeLocal.makeTranslation(0, 0.04, 0.55)
    this.scanLocal.makeRotationX(Math.PI / 2)
    this.thrusterLocalL.makeTranslation(-0.55, -0.3, 0)
    this.thrusterLocalR.makeTranslation(0.55, -0.3, 0)

    this.bodyMesh = new THREE.InstancedMesh(bodyGeo, bodyMat, n)
    this.shellMesh = new THREE.InstancedMesh(shellGeo, shellMat, n)
    this.eyeMesh = new THREE.InstancedMesh(eyeGeo, eyeMat, n)
    this.scanMesh = new THREE.InstancedMesh(scanGeo, scanMat, n)
    this.thrusterMesh = new THREE.InstancedMesh(thrusterGeo, thrusterMat, n * 2)
    for (const im of [this.bodyMesh, this.shellMesh, this.eyeMesh, this.scanMesh, this.thrusterMesh]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      im.frustumCulled = false // drones roam a wide area; cull per-instance is moot here
      this.group.add(im)
    }
    // Seed eye instance colors (enables instanceColor buffer) and start hidden.
    const seed = new THREE.Color(1, 0.18, 0.13)
    for (let i = 0; i < n; i++) {
      this.eyeMesh.setColorAt(i, seed)
      this.bodyMesh.setMatrixAt(i, this.mHidden)
      this.shellMesh.setMatrixAt(i, this.mHidden)
      this.eyeMesh.setMatrixAt(i, this.mHidden)
      this.scanMesh.setMatrixAt(i, this.mHidden)
      this.thrusterMesh.setMatrixAt(i * 2, this.mHidden)
      this.thrusterMesh.setMatrixAt(i * 2 + 1, this.mHidden)
    }
    if (this.eyeMesh.instanceColor) this.eyeMesh.instanceColor.needsUpdate = true

    for (let i = 0; i < n; i++) {
      const pos = new THREE.Vector3()
      const drone: Drone = {
        index: i,
        eyeColor: new THREE.Color(1, 0.18, 0.13),
        pos,
        vel: new THREE.Vector3(),
        home: new THREE.Vector3(),
        state: 'patrol',
        bob: Math.random() * Math.PI * 2,
        spin: Math.random() * Math.PI * 2,
        glow: 1,
        zapCd: 0,
        recoil: 0,
        destroyed: false,
        respawn: 0,
        visible: false,
        cap: { position: pos, alive: true, capture: () => this.onCaptured(drone) },
      }
      this.placeFar(drone)
      this.drones.push(drone)
      capturables.push(drone.cap)
    }
    // placeFar leaves drones positioned; write their matrices once so the first
    // frame (and any frame where update early-returns) renders them correctly.
    for (const d of this.drones) this.writeDrone(d, true, 0, d.spin)

    this.group.visible = false
    scene.add(this.group)
  }

  /**
   * Compose a drone's group world matrix from its position + heading (faceY) +
   * spin (spinZ) and stamp every instanced part. Pass visible=false to hide the
   * drone by writing zero-scale matrices into all its instance slots.
   */
  private writeDrone(d: Drone, visible: boolean, faceY = 0, spinZ = 0) {
    if (!visible) {
      if (!d.visible) return // already hidden
      d.visible = false
      this.bodyMesh.setMatrixAt(d.index, this.mHidden)
      this.shellMesh.setMatrixAt(d.index, this.mHidden)
      this.eyeMesh.setMatrixAt(d.index, this.mHidden)
      this.scanMesh.setMatrixAt(d.index, this.mHidden)
      this.thrusterMesh.setMatrixAt(d.index * 2, this.mHidden)
      this.thrusterMesh.setMatrixAt(d.index * 2 + 1, this.mHidden)
      this.flagMatrices()
      return
    }
    d.visible = true

    // Group transform: position + rotation.y (face) + rotation.z (spin).
    this.eScratch.set(0, faceY, spinZ, 'XYZ')
    this.qScratch.setFromEuler(this.eScratch)
    this.mWorld.compose(d.pos, this.qScratch, this.sUnit)

    this.bodyMesh.setMatrixAt(d.index, this.mWorld) // body has no local offset
    this.mPart.multiplyMatrices(this.mWorld, this.shellLocal)
    this.shellMesh.setMatrixAt(d.index, this.mPart)
    this.mPart.multiplyMatrices(this.mWorld, this.eyeLocal)
    this.eyeMesh.setMatrixAt(d.index, this.mPart)
    this.mPart.multiplyMatrices(this.mWorld, this.scanLocal)
    this.scanMesh.setMatrixAt(d.index, this.mPart)
    this.mPart.multiplyMatrices(this.mWorld, this.thrusterLocalL)
    this.thrusterMesh.setMatrixAt(d.index * 2, this.mPart)
    this.mPart.multiplyMatrices(this.mWorld, this.thrusterLocalR)
    this.thrusterMesh.setMatrixAt(d.index * 2 + 1, this.mPart)
    this.flagMatrices()
  }

  private flagMatrices() {
    this.bodyMesh.instanceMatrix.needsUpdate = true
    this.shellMesh.instanceMatrix.needsUpdate = true
    this.eyeMesh.instanceMatrix.needsUpdate = true
    this.scanMesh.instanceMatrix.needsUpdate = true
    this.thrusterMesh.instanceMatrix.needsUpdate = true
  }

  /** Drop a drone at a fresh home point, away from the player (spawn + respawn). */
  private placeFar(d: Drone) {
    const focus = this.deps.focus()
    let x = 0, z = 0
    for (let i = 0; i < 6; i++) {
      x = (Math.random() * 2 - 1) * AREA
      z = (Math.random() * 2 - 1) * AREA
      const dx = x - focus.x, dz = z - focus.z
      if (dx * dx + dz * dz > 60 * 60) break // comfortably outside detect range
    }
    d.home.set(x, 0, z)
    d.pos.set(x, this.deps.groundY(x, z) + HOVER, z)
    d.vel.set(0, 0, 0)
    d.state = 'patrol'
  }

  /** Netted/blasted: destroy, hide, schedule a respawn, pay the bounty. */
  private onCaptured(d: Drone): number {
    d.destroyed = true
    d.cap.alive = false
    d.vel.set(0, 0, 0)
    d.respawn = 6 + Math.random() * 3
    this.writeDrone(d, false)
    return 60
  }

  setZone(zone: Zone) {
    this.zone = zone
    const on = zone === 'earth'
    this.group.visible = on
    for (const d of this.drones) d.cap.alive = on && !d.destroyed
  }

  update(dt: number) {
    const onEarth = this.zone === 'earth'
    if (this.group.visible !== onEarth) this.group.visible = onEarth
    if (!onEarth) return

    const focus = this.deps.focus()
    for (const d of this.drones) {
      if (d.destroyed) {
        d.respawn -= dt
        if (d.respawn <= 0) {
          d.destroyed = false
          this.placeFar(d)
          d.cap.alive = true
          // re-show on next write below
        } else {
          continue
        }
      }

      if (d.zapCd > 0) d.zapCd -= dt
      if (d.recoil > 0) d.recoil -= dt
      d.bob += dt
      d.spin += dt * (d.state === 'chase' ? 5 : 2)

      // toPlayer (horizontal-aware, but kept full so we can hover at head height)
      this.toPlayer.copy(focus).sub(d.pos)
      const distSq = this.toPlayer.x * this.toPlayer.x + this.toPlayer.z * this.toPlayer.z
      const dist = Math.sqrt(distSq)

      // State transitions.
      if (dist < DETECT) d.state = 'chase'
      else if (d.state === 'chase' && dist > DETECT * 1.25) d.state = 'patrol'

      if (d.state === 'chase') {
        if (d.recoil > 0) {
          // Recoiling: shove away from the player briefly after a zap.
          this.desired.copy(this.toPlayer).setY(0)
          if (dist > 0.001) this.desired.multiplyScalar(-CHASE_SPEED / dist)
          else this.desired.set(0, 0, 0)
        } else {
          // Close in on the player (clamped so it stays dodgeable).
          this.desired.copy(this.toPlayer).setY(0)
          if (dist > 0.001) this.desired.multiplyScalar(CHASE_SPEED / dist)
          else this.desired.set(0, 0, 0)
          // Contact zap: shove the player away on a cooldown, then recoil.
          if (dist < CONTACT && d.zapCd <= 0) {
            const inv = dist > 0.001 ? 1 / dist : 0
            const kx = -this.toPlayer.x * inv // points FROM drone TO player
            const kz = -this.toPlayer.z * inv
            this.deps.onZap(kx * 9, kz * 9, 5)
            d.zapCd = 1.5
            d.recoil = 0.4
          }
        }
      } else {
        // Patrol: lazy drift around the home point.
        this.toHome.copy(d.home).sub(d.pos).setY(0)
        const hd = this.toHome.length()
        if (hd > 0.001) this.toHome.multiplyScalar(PATROL_SPEED / hd)
        this.desired.set(
          this.toHome.x + Math.cos(d.spin * 0.6) * PATROL_SPEED * 0.5,
          0,
          this.toHome.z + Math.sin(d.spin * 0.6) * PATROL_SPEED * 0.5,
        )
      }

      // Ease velocity toward desired (frame-rate-independent), integrate.
      const k = Math.min(1, dt * 3)
      d.vel.x += (this.desired.x - d.vel.x) * k
      d.vel.z += (this.desired.z - d.vel.z) * k
      d.pos.x += d.vel.x * dt
      d.pos.z += d.vel.z * dt

      // Keep within the play area.
      if (Math.abs(d.pos.x) > AREA) { d.pos.x = Math.sign(d.pos.x) * AREA; d.vel.x *= -0.5 }
      if (Math.abs(d.pos.z) > AREA) { d.pos.z = Math.sign(d.pos.z) * AREA; d.vel.z *= -0.5 }

      // Hover: chase at the player's head height, else fixed height over ground.
      const ground = this.deps.groundY(d.pos.x, d.pos.z) + HOVER
      const target = d.state === 'chase' ? Math.max(ground, focus.y + 1.2) : ground
      d.pos.y += (target + Math.sin(d.bob * 2.2) * 0.18 - d.pos.y) * Math.min(1, dt * 4)

      // Face the player while chasing, else heading.
      const faceY = d.state === 'chase'
        ? Math.atan2(this.toPlayer.x, this.toPlayer.z)
        : Math.atan2(d.vel.x, d.vel.z)
      const spinZ = d.spin // spinning shell/scanner

      // Eye glow: pulse brighter and faster while chasing.
      const targetGlow = d.state === 'chase' ? 1.6 + 0.4 * Math.sin(d.spin * 3) : 0.7
      d.glow += (targetGlow - d.glow) * Math.min(1, dt * 6)
      d.eyeColor.setRGB(Math.min(1, d.glow), Math.min(0.4, d.glow * 0.18), 0.13)
      this.eyeMesh.setColorAt(d.index, d.eyeColor)

      this.writeDrone(d, true, faceY, spinZ)
    }
    if (this.eyeMesh.instanceColor) this.eyeMesh.instanceColor.needsUpdate = true
  }

  dispose() {
    for (const g of this.geos) g.dispose()
    for (const m of this.mats) m.dispose()
    this.bodyMesh.dispose()
    this.shellMesh.dispose()
    this.eyeMesh.dispose()
    this.scanMesh.dispose()
    this.thrusterMesh.dispose()
  }
}
