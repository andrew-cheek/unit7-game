import * as THREE from 'three'
import { config } from './config'
import { createBigShip, createSmallShip, type VehicleModel } from './procedural'
import { randRange } from './utils'

interface SmallShip {
  model: VehicleModel
  cx: number
  cz: number
  rx: number
  rz: number
  y: number
  theta: number
  speed: number
}

/**
 * Sky traffic: a handful of small ships flying steady loops weaving between the
 * towers, each trailing a glowing engine plume, plus an occasional big capital
 * ship that crosses the whole skyline. Parametric paths (no physics) so it's
 * cheap and never collides. Runs on Earth and Mars; counts from `config.city`.
 */
export class Sky {
  private scene: THREE.Scene
  private group = new THREE.Group()
  private ships: SmallShip[] = []
  private big: VehicleModel
  private bigTrailMat: THREE.MeshBasicMaterial
  private bigActive = false
  private bigTimer = config.city.bigShipInterval
  private bigFrom = new THREE.Vector3()
  private bigTo = new THREE.Vector3()
  private bigT = 0

  constructor(scene: THREE.Scene, densityScale: number) {
    this.scene = scene
    scene.add(this.group)

    const n = Math.round(config.city.smallShips * densityScale)
    const accents = [config.palette.cyan, config.palette.magenta, config.palette.orange, config.palette.lime]
    for (let i = 0; i < n; i++) {
      const model = createSmallShip(accents[i % accents.length])
      // A glowing engine trail streaming behind (additive, static to the ship).
      const trailMat = new THREE.MeshBasicMaterial({ color: accents[i % accents.length], transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
      const trail = new THREE.Mesh(new THREE.ConeGeometry(0.4, 4.5, 10, 1, true), trailMat)
      trail.rotation.x = -Math.PI / 2 // taper backward along -Z
      trail.position.z = -3.5
      model.group.add(trail)
      this.group.add(model.group)
      this.ships.push({
        model,
        cx: randRange(-120, 120),
        cz: randRange(-120, 120),
        rx: randRange(40, 110),
        rz: randRange(40, 110),
        y: randRange(24, 64),
        theta: randRange(0, Math.PI * 2),
        speed: randRange(0.12, 0.3) * (i % 2 ? 1 : -1),
      })
    }

    this.big = createBigShip()
    this.big.group.visible = false
    this.bigTrailMat = new THREE.MeshBasicMaterial({ color: config.palette.cyan, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    const bigTrail = new THREE.Mesh(new THREE.ConeGeometry(2.2, 30, 14, 1, true), this.bigTrailMat)
    bigTrail.rotation.x = -Math.PI / 2
    bigTrail.position.z = -26
    this.big.group.add(bigTrail)
    this.group.add(this.big.group)
  }

  setVisible(v: boolean) {
    this.group.visible = v
  }

  update(dt: number) {
    if (!this.group.visible) return
    for (const s of this.ships) {
      s.theta += s.speed * dt
      const x = s.cx + Math.cos(s.theta) * s.rx
      const z = s.cz + Math.sin(s.theta) * s.rz
      const y = s.y + Math.sin(s.theta * 2) * 4
      s.model.group.position.set(x, y, z)
      // Face along the path tangent, with a little bank into the turn.
      const dx = -Math.sin(s.theta) * s.rx * s.speed
      const dz = Math.cos(s.theta) * s.rz * s.speed
      s.model.group.rotation.set(0, Math.atan2(dx, dz), Math.sign(s.speed) * 0.3)
      s.model.update(dt, 1)
    }
    this.updateBig(dt)
  }

  private updateBig(dt: number) {
    if (!this.bigActive) {
      this.bigTimer -= dt
      if (this.bigTimer <= 0) {
        // Cross the sky from one edge to the other, high overhead.
        const y = randRange(120, 165)
        const side = Math.random() < 0.5
        const off = randRange(-120, 120)
        this.bigFrom.set(side ? -340 : off, y, side ? off : -340)
        this.bigTo.set(side ? 340 : off, y, side ? off : 340)
        this.big.group.position.copy(this.bigFrom)
        this.big.group.lookAt(this.bigTo)
        this.big.group.visible = true
        this.bigActive = true
        this.bigT = 0
      }
      return
    }
    this.bigT += dt * 0.05 // slow, majestic pass
    this.big.group.position.lerpVectors(this.bigFrom, this.bigTo, this.bigT)
    this.bigTrailMat.opacity = 0.25 + Math.sin(this.bigT * 20) * 0.06
    if (this.bigT >= 1) {
      this.big.group.visible = false
      this.bigActive = false
      this.bigTimer = config.city.bigShipInterval
    }
  }

  /** Small-ship + active big-ship positions for the radar. */
  forEach(fn: (x: number, z: number) => void) {
    for (const s of this.ships) fn(s.model.group.position.x, s.model.group.position.z)
    if (this.bigActive) fn(this.big.group.position.x, this.big.group.position.z)
  }

  dispose() {
    for (const s of this.ships) s.model.dispose()
    this.big.dispose()
    this.bigTrailMat.dispose()
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry && (m.material as THREE.Material)?.transparent) m.geometry.dispose()
    })
    this.scene.remove(this.group)
  }
}
