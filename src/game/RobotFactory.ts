// RobotFactory - a big plant where robots build robots, and the finished units
// march out into the city: some head for the road (to ride off), some for the
// spaceport, some just roam. A landmark assembly hall with swinging robotic
// arms, a stamping press, a conveyor of half-built units, and a steady trickle
// of emitted walkers. Earth-only; cheap + fully disposed on teardown.

import * as THREE from 'three'
import { config } from './config'
import { createCitizen, type CharacterModel } from './procedural'
import type { Physics } from './Physics'

interface Walker {
  model: CharacterModel
  to: THREE.Vector3
  t: number
}

// Where the plant sits (mid-ring, off a main avenue) and which way its open
// front faces (toward the city centre).
const SITE = new THREE.Vector3(-110, 0, 64)
const FACE = Math.PI // open front toward -Z (the city)

export class RobotFactory {
  private scene: THREE.Scene
  private physics: Physics
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private arms: { pivot: THREE.Group; speed: number; phase: number }[] = []
  private press!: THREE.Object3D
  private belt: THREE.Object3D[] = []
  private sparks: THREE.MeshBasicMaterial[] = []
  private walkers: Walker[] = []
  private vscratch = new THREE.Vector3()
  private active = true
  private emitTimer = 2
  private t = 0

  constructor(scene: THREE.Scene, physics: Physics) {
    this.scene = scene
    this.physics = physics
    this.group.position.copy(SITE)
    this.group.position.y = physics.sampleGround(SITE.x, SITE.z, 80)?.y ?? 0
    this.group.rotation.y = FACE
    this.build()
    scene.add(this.group)
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }

  setActive(on: boolean) {
    this.active = on
    this.group.visible = on
    if (!on) this.clearWalkers()
  }

  private build() {
    const W = 34, D = 24, H = 13
    const shell = this.own(new THREE.MeshStandardMaterial({ color: 0x20262f, metalness: 0.6, roughness: 0.5 }))
    const deck = this.own(new THREE.MeshStandardMaterial({ color: 0x14171d, metalness: 0.5, roughness: 0.7 }))
    const steel = this.own(new THREE.MeshStandardMaterial({ color: 0x3a4350, metalness: 0.8, roughness: 0.35 }))
    const lit = this.own(new THREE.MeshBasicMaterial({ color: 0xffe6b0 }))
    const box = (w: number, h: number, d: number, m: THREE.Material) => new THREE.Mesh(this.ownG(new THREE.BoxGeometry(w, h, d)), m)

    // Floor slab + back/side walls + roof (open front at +Z).
    const floor = box(W, 0.4, D, deck); floor.position.set(0, 0.2, -D / 2); floor.receiveShadow = true; this.group.add(floor)
    const back = box(W, H, 0.6, shell); back.position.set(0, H / 2, -D); back.castShadow = true; this.group.add(back)
    for (const sx of [-1, 1]) { const s = box(0.6, H, D, shell); s.position.set((sx * W) / 2, H / 2, -D / 2); this.group.add(s) }
    const roof = box(W, 0.6, D, shell); roof.position.set(0, H, -D / 2); roof.castShadow = true; this.group.add(roof)
    // Sawtooth roof skylights (factory read) + ceiling light strips.
    for (let i = -2; i <= 2; i++) {
      const strip = box(W * 0.8, 0.2, 0.7, lit); strip.position.set(0, H - 0.3, -D / 2 + i * 4); this.group.add(strip)
    }
    // Big sign band over the entrance.
    const sign = box(W * 0.7, 1.6, 0.4, this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.orange, emissiveIntensity: 2.6, roughness: 0.4 })))
    sign.position.set(0, H + 1.1, 0.4); this.group.add(sign)

    // Conveyor belt running front-to-back through the hall.
    const belt = box(3.2, 0.4, D - 4, steel); belt.position.set(-6, 1.2, -D / 2); this.group.add(belt)
    // Half-built units riding the belt (recycled in update -> a finished walker).
    const unitMat = this.own(new THREE.MeshStandardMaterial({ color: config.palette.robot, metalness: 0.7, roughness: 0.4 }))
    for (let i = 0; i < 5; i++) {
      const u = new THREE.Group()
      const torso = box(0.6, 0.9, 0.5, unitMat); torso.position.y = 0.85; u.add(torso)
      const head = box(0.4, 0.4, 0.4, unitMat); head.position.y = 1.5; u.add(head)
      u.scale.setScalar(0.6 + i * 0.1) // grows as it nears completion
      u.position.set(-6, 1.4, -D + 2 + i * 4)
      this.group.add(u); this.belt.push(u)
    }

    // Robotic assembly arms over the line: a base + upper arm + forearm; swing.
    for (let i = 0; i < 3; i++) {
      const pivot = new THREE.Group()
      pivot.position.set(-6 + (i - 1) * 0.5, 3.4, -D + 5 + i * 5.5)
      const upper = box(0.3, 2.4, 0.3, steel); upper.position.y = -1.0; pivot.add(upper)
      const fore = box(0.24, 1.6, 0.24, steel); fore.position.set(0, -2.4, 0.5); pivot.add(fore)
      const tip = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.16, 8, 8)), this.own(new THREE.MeshBasicMaterial({ color: 0xfff0b0 })))
      tip.position.set(0, -3.1, 0.9); pivot.add(tip)
      this.sparks.push(tip.material as THREE.MeshBasicMaterial)
      const base = box(0.5, 0.6, 0.5, shell); base.position.set(-6 + (i - 1) * 0.5, 3.7, -D + 5 + i * 5.5); this.group.add(base)
      this.group.add(pivot)
      this.arms.push({ pivot, speed: 2 + i * 0.5, phase: i * 1.7 })
    }

    // A stamping press near the line head.
    this.press = box(3.4, 1.2, 2.4, steel)
    this.press.position.set(-6, 5, -D + 4); this.group.add(this.press)
    for (const sx of [-1.6, 1.6]) { const col = box(0.4, 5, 0.4, shell); col.position.set(-6 + sx, 2.7, -D + 4); this.group.add(col) }

    // Stacks of finished crates / charging bays on the other side.
    const bay = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.lime, emissiveIntensity: 2.0, roughness: 0.5 }))
    for (let i = 0; i < 4; i++) { const c = box(0.2, 1.4, 0.5, bay); c.position.set(9, 1.0, -D + 3 + i * 2.2); this.group.add(c) }
  }

  /** A city target for a freshly-built robot: head to a road to ride off, to the
   *  spaceport, or just roam. Returned in world space. */
  private pickDestination(): THREE.Vector3 {
    const r = Math.random()
    if (r < 0.4) {
      // To a road/avenue point - "catch a ride" (then it despawns there).
      const pitch = config.world.block + config.world.roadWidth
      const gx = (Math.round((Math.random() * 2 - 1) * 3) * pitch)
      return new THREE.Vector3(gx, 0, (Math.random() * 2 - 1) * 60)
    }
    if (r < 0.62) {
      // To the spaceport rockets behind spawn.
      return new THREE.Vector3(-14 + Math.random() * 30, 0, -24 + Math.random() * 6)
    }
    // Roam toward a random spot in the inner city.
    const a = Math.random() * Math.PI * 2
    const d = 40 + Math.random() * 90
    return new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d)
  }

  private emitRobot() {
    const cap = config.tier.fxScale >= 0.9 ? 9 : config.tier.fxScale >= 0.6 ? 6 : 4
    if (this.walkers.length >= cap) return
    const model = createCitizen({ outfit: config.palette.robot, robot: true })
    // Exit the open front of the hall, into the world.
    const exit = this.vscratch.set(-6, 0, 2).applyEuler(this.group.rotation).add(this.group.position)
    model.group.position.set(exit.x, this.physics.sampleGround(exit.x, exit.z, 40)?.y ?? 0, exit.z)
    this.scene.add(model.group)
    this.walkers.push({ model, to: this.pickDestination(), t: 0 })
  }

  update(dt: number) {
    if (!this.active) return
    this.t += dt
    // Swing the arms + flicker their welding sparks.
    for (const a of this.arms) {
      a.pivot.rotation.x = Math.sin(this.t * a.speed + a.phase) * 0.5
      a.pivot.rotation.z = Math.cos(this.t * a.speed * 0.7 + a.phase) * 0.25
    }
    for (const s of this.sparks) s.opacity = Math.random() < 0.5 ? 1 : 0.15
    // Stamping press bobs.
    this.press.position.y = 5 + Math.abs(Math.sin(this.t * 2.2)) * -0.8 + 0.4
    // Belt advances; units that reach the front recycle to the back + a finished
    // robot is emitted into the city.
    const D = 24
    for (const u of this.belt) {
      u.position.z += dt * 3.0
      if (u.position.z > 2) { u.position.z = -D + 2; this.emitRobot() }
    }

    // Walk the emitted robots toward their city destination; despawn on arrival.
    const speed = 3.2
    for (let i = this.walkers.length - 1; i >= 0; i--) {
      const w = this.walkers[i]
      w.t += dt
      const p = w.model.group.position
      const dx = w.to.x - p.x, dz = w.to.z - p.z
      const d = Math.hypot(dx, dz)
      if (d < 1.5 || w.t > 22) {
        this.scene.remove(w.model.group); w.model.dispose(); this.walkers.splice(i, 1); continue
      }
      const vx = (dx / d) * speed, vz = (dz / d) * speed
      p.x += vx * dt; p.z += vz * dt
      this.vscratch.set(vx, 0, vz)
      this.physics.resolveHorizontal(p, this.vscratch, 0.4, 1.6)
      p.y = this.physics.sampleGround(p.x, p.z, p.y + 4)?.y ?? p.y
      w.model.group.rotation.y = Math.atan2(dx, dz)
      w.model.update(dt, 0.8, true)
    }
    void this.emitTimer
  }

  private clearWalkers() {
    for (const w of this.walkers) { this.scene.remove(w.model.group); w.model.dispose() }
    this.walkers = []
  }

  dispose() {
    this.clearWalkers()
    this.scene.remove(this.group)
    this.mats.forEach((m) => m.dispose())
    this.geos.forEach((g) => g.dispose())
  }
}
