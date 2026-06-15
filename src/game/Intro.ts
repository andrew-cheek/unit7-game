import * as THREE from 'three'
import { clamp } from './utils'

const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const pop = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3)) // ease-out with slight snap

// Factory sits far from the city so the cinematic has its own clean stage.
const ORIGIN = new THREE.Vector3(0, 0, -380)
const DURATION = 6.6

/**
 * Skippable opening cinematic: a robot is assembled on a sci-fi factory line
 * (torso → limbs → head) with welding sparks, a holographic rig and bay doors
 * that open to roll it out toward the city. Drives the camera itself; Game hands
 * control over while `done` is false, then snaps to gameplay.
 */
export class Intro {
  readonly group = new THREE.Group()
  done = false
  private t = 0
  private scene: THREE.Scene
  private cam: THREE.PerspectiveCamera
  private mats: THREE.Material[] = []

  private torso!: THREE.Group
  private armL!: THREE.Mesh
  private armR!: THREE.Mesh
  private legL!: THREE.Mesh
  private legR!: THREE.Mesh
  private head!: THREE.Group
  private eyes!: THREE.Mesh
  private robot = new THREE.Group()
  private doorL!: THREE.Mesh
  private doorR!: THREE.Mesh
  private armRig: THREE.Group[] = []
  private holo: THREE.Mesh[] = []
  private weldLight!: THREE.PointLight
  private sparks!: THREE.Points
  private sparkVel!: Float32Array
  private weldPos = new THREE.Vector3()

  constructor(scene: THREE.Scene, cam: THREE.PerspectiveCamera) {
    this.scene = scene
    this.cam = cam
    this.group.position.copy(ORIGIN)
    this.build()
    scene.add(this.group)
  }

  private own<T extends THREE.Material>(m: T): T {
    this.mats.push(m)
    return m
  }
  private metal(color: number, e = 0) {
    return this.own(new THREE.MeshStandardMaterial({ color, metalness: 0.85, roughness: 0.35, emissive: e, emissiveIntensity: e ? 2.5 : 0 }))
  }

  private build() {
    const floorMat = this.metal(0x12151c)
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 0.6, 40), floorMat)
    floor.receiveShadow = true
    this.group.add(floor)
    // glowing assembly ring on the floor
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.5, 0.12, 12, 48), this.metal(0x05060b, 1).clone())
    ;(ring.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0x27e7ff)
    ;(ring.material as THREE.MeshStandardMaterial).emissiveIntensity = 2.6
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.32
    this.group.add(ring)

    // bay doors (slide apart) behind the robot, toward the city (+Z toward origin/city)
    const doorMat = this.metal(0x1a1f2b)
    this.doorL = new THREE.Mesh(new THREE.BoxGeometry(7, 16, 0.8), doorMat)
    this.doorR = new THREE.Mesh(new THREE.BoxGeometry(7, 16, 0.8), doorMat)
    this.doorL.position.set(-3.6, 8, 12)
    this.doorR.position.set(3.6, 8, 12)
    this.group.add(this.doorL, this.doorR)
    for (const sx of [-7.4, 7.4]) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.8, 17, 1.4), this.metal(0x05060b, 1.2))
      ;(frame.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0xff8a1e)
      frame.position.set(sx, 8.5, 12)
      this.group.add(frame)
    }

    // pillars + overhead gantry
    for (const sx of [-11, 11]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(1, 18, 1), this.metal(0x20242f))
      pillar.position.set(sx, 9, -8)
      this.group.add(pillar)
    }

    // articulated welding arms
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2
      const base = new THREE.Group()
      base.position.set(Math.cos(a) * 6.5, 0, Math.sin(a) * 6.5)
      const seg1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4, 0.5), this.metal(0x2a3140))
      seg1.position.y = 2
      const elbow = new THREE.Group()
      elbow.position.y = 4
      const seg2 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3, 0.4), this.metal(0x2a3140))
      seg2.position.y = 1.5
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), this.metal(0x05060b, 3))
      ;(tip.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0x59d0ff)
      tip.position.y = 3
      elbow.add(seg2, tip)
      base.add(seg1, elbow)
      base.rotation.y = -a
      this.group.add(base)
      this.armRig.push(base)
    }

    // holographic rings around the assembly
    for (let i = 0; i < 2; i++) {
      const h = new THREE.Mesh(
        new THREE.TorusGeometry(3.2 + i * 0.8, 0.04, 8, 60),
        this.own(new THREE.MeshBasicMaterial({ color: i ? 0xff2bd0 : 0x27e7ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })),
      )
      h.position.y = 2.5
      this.group.add(h)
      this.holo.push(h)
    }

    this.buildRobot()
    this.group.add(this.robot)

    // lights for the factory stage
    const key = new THREE.PointLight(0xbfd2ff, 120, 60, 2)
    key.position.set(6, 16, -6)
    const fill = new THREE.PointLight(0x27e7ff, 60, 50, 2)
    fill.position.set(-8, 6, 8)
    this.group.add(key, fill)

    this.weldLight = new THREE.PointLight(0x9fd8ff, 0, 18, 2)
    this.weldLight.position.set(0, 2, 0)
    this.group.add(this.weldLight)

    // spark particles
    const N = 80
    const pos = new Float32Array(N * 3)
    this.sparkVel = new Float32Array(N * 3)
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const sm = this.own(new THREE.PointsMaterial({ color: 0xffd9a8, size: 0.18, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }))
    this.sparks = new THREE.Points(sg, sm)
    this.sparks.frustumCulled = false
    this.group.add(this.sparks)
  }

  private buildRobot() {
    const body = this.metal(0xc9d4e3)
    const dark = this.metal(0x2a3140)
    const trim = this.metal(0x05060b, 3)
    trim.emissive = new THREE.Color(0x27e7ff)

    this.torso = new THREE.Group()
    const chest = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.7, 0.9), body)
    chest.position.y = 3.5
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.7, 0.8), dark)
    pelvis.position.y = 2.6
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.2, 16), trim)
    core.rotation.x = Math.PI / 2
    core.position.set(0, 3.7, 0.5)
    this.torso.add(chest, pelvis, core)
    this.robot.add(this.torso)

    const mkLeg = (sx: number) => {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.45, 2.6, 0.5), body)
      leg.position.set(sx, 1.3, 0)
      this.robot.add(leg)
      return leg
    }
    this.legL = mkLeg(-0.42)
    this.legR = mkLeg(0.42)
    const mkArm = (sx: number) => {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.9, 0.42), body)
      arm.position.set(sx, 3.4, 0)
      this.robot.add(arm)
      return arm
    }
    this.armL = mkArm(-0.95)
    this.armR = mkArm(0.95)

    this.head = new THREE.Group()
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.8, 0.85), body)
    this.eyes = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.1), trim)
    this.eyes.position.set(0, 0.05, 0.42)
    this.head.add(skull, this.eyes)
    this.head.position.y = 4.85
    this.robot.add(this.head)

    this.robot.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) m.castShadow = true
    })
  }

  private reveal(part: THREE.Object3D, s: number) {
    part.scale.setScalar(0.0001 + s)
    part.visible = s > 0.001
  }

  private burstSparks(at: THREE.Vector3) {
    const pos = (this.sparks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = at.x
      pos[i + 1] = at.y
      pos[i + 2] = at.z
      this.sparkVel[i] = (Math.random() - 0.5) * 6
      this.sparkVel[i + 1] = Math.random() * 7 + 2
      this.sparkVel[i + 2] = (Math.random() - 0.5) * 6
    }
    ;(this.sparks.material as THREE.PointsMaterial).opacity = 1
    ;(this.sparks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  }

  skip() {
    if (!this.done) {
      this.t = DURATION
      this.finish()
    }
  }

  private finish() {
    this.done = true
  }

  update(dt: number) {
    if (this.done) return
    this.t += dt
    const t = this.t

    // assembly stages: torso(0-1.4) legs(1.2-2.6) arms(2.4-3.6) head(3.4-4.4)
    this.reveal(this.torso, pop(smooth(0.1, 1.4, t)))
    this.reveal(this.legL, pop(smooth(1.2, 2.4, t)))
    this.reveal(this.legR, pop(smooth(1.3, 2.5, t)))
    this.reveal(this.armL, pop(smooth(2.3, 3.4, t)))
    this.reveal(this.armR, pop(smooth(2.4, 3.5, t)))
    this.reveal(this.head, pop(smooth(3.4, 4.4, t)))

    // welding bursts at stage boundaries
    const weldStages = [0.9, 2.0, 3.0, 4.0]
    this.weldPos.set(0, 0, 0)
    for (const ws of weldStages) {
      if (t > ws && t < ws + 0.18) {
        this.weldPos.set(0, 2.5 + (ws - 0.9), 0.6).add(ORIGIN)
        this.burstSparks(this.weldPos.clone().sub(ORIGIN))
        this.weldLight.intensity = 200
      }
    }
    this.weldLight.intensity *= 0.86

    // advance sparks
    const sp = (this.sparks.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
    for (let i = 0; i < sp.length; i += 3) {
      this.sparkVel[i + 1] -= 18 * dt
      sp[i] += this.sparkVel[i] * dt
      sp[i + 1] += this.sparkVel[i + 1] * dt
      sp[i + 2] += this.sparkVel[i + 2] * dt
    }
    ;(this.sparks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    const sm = this.sparks.material as THREE.PointsMaterial
    sm.opacity = Math.max(0, sm.opacity - dt * 1.4)

    // arms sweep in during assembly, retract after
    const armActive = smooth(0.2, 1.0, t) * (1 - smooth(4.4, 5.2, t))
    this.armRig.forEach((rig, i) => {
      rig.rotation.y = -((i / 3) * Math.PI * 2) + Math.sin(t * 2 + i) * 0.3 * armActive
      const elbow = rig.children[1] as THREE.Group
      elbow.rotation.x = -1.1 * armActive + Math.sin(t * 3 + i) * 0.15 * armActive
    })

    // holo rings spin + fade out at power-on
    const holoVis = 1 - smooth(4.4, 5.4, t)
    this.holo.forEach((h, i) => {
      h.rotation.x = Math.PI / 2 + Math.sin(t + i) * 0.2
      h.rotation.z = t * (i ? -0.8 : 0.8)
      ;(h.material as THREE.MeshBasicMaterial).opacity = 0.5 * holoVis
    })

    // power-on: eyes flare
    const power = smooth(4.3, 4.8, t)
    ;(this.eyes.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.2 + power * 5

    // bay doors open + roll-out toward the city (+Z)
    const open = smooth(4.8, 5.8, t)
    this.doorL.position.x = -3.6 - open * 8
    this.doorR.position.x = 3.6 + open * 8
    const roll = smooth(5.4, 6.4, t)
    this.robot.position.z = roll * 24

    // camera choreography
    const robotWorld = new THREE.Vector3(0, 3, this.robot.position.z).add(ORIGIN)
    if (t < 4.6) {
      const a = t * 0.6 - 1
      this.cam.position.set(ORIGIN.x + Math.sin(a) * 11, 5 + Math.sin(t * 0.5) * 1.5, ORIGIN.z + Math.cos(a) * 11)
      this.cam.lookAt(ORIGIN.x, 3.4, ORIGIN.z)
    } else {
      // pull behind and follow through the doors
      this.cam.position.lerp(new THREE.Vector3(robotWorld.x + 2, robotWorld.y + 3, robotWorld.z - 12), 0.06)
      this.cam.lookAt(robotWorld.x, robotWorld.y, robotWorld.z + 4)
    }

    if (t >= DURATION) this.finish()
  }

  dispose() {
    this.scene.remove(this.group)
    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    this.mats.forEach((m) => m.dispose())
  }
}
