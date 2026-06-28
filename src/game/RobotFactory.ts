// RobotFactory - a big plant where robots build robots, and the finished units
// march out into the city: some head for the road (to ride off), some for the
// spaceport, some just roam. A landmark assembly hall styled after the concept
// art: a chunky dark-navy block with cyan neon edge-trim, glass-fronted assembly
// floors (swinging arms, a stamping press, a conveyor of half-built units), a big
// glowing octagonal robot-head logo, corner light-pillars and a rooftop antenna.
// Solid: the shell registers AABB colliders so you can't walk through it.
// Earth-only; cheap + fully disposed on teardown.

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

// Footprint (local space): open front at +Z (z=0), back wall at z=-D.
const W = 32 // width (x)
const D = 24 // depth (z)
const FH = 5.6 // floor height
const FLOORS = 3
const H = FH * FLOORS // shell height (~16.8)

export class RobotFactory {
  // Drop-in targets: the rooftop landing pad on the intake tower (world space)
  // and where the player ends up "inside" after dropping through it.
  readonly roofPad = new THREE.Vector3()
  readonly entrance = new THREE.Vector3()
  private padMat: THREE.MeshBasicMaterial | null = null

  private scene: THREE.Scene
  private physics: Physics
  private group = new THREE.Group()
  private mats: THREE.Material[] = []
  private geos: THREE.BufferGeometry[] = []
  private texs: THREE.Texture[] = []
  private arms: { pivot: THREE.Group; speed: number; phase: number }[] = []
  private press!: THREE.Object3D
  private belt: THREE.Object3D[] = []
  private sparks: THREE.MeshBasicMaterial[] = []
  private walkers: Walker[] = []
  private vscratch = new THREE.Vector3()
  private colliders: THREE.Box3[] = []
  private logoMat: THREE.MeshBasicMaterial | null = null
  private beaconMat: THREE.MeshBasicMaterial | null = null
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
    this.group.updateMatrixWorld(true)
    this.buildColliders()
    // World-space drop targets (the build placed the pad in local space).
    this.roofPad.set(0, 26, -18).applyEuler(this.group.rotation).add(this.group.position)
    this.entrance.set(0, 0, -8).applyEuler(this.group.rotation).add(this.group.position)
    scene.add(this.group)
  }

  /** Pulse the rooftop landing pad (drives the drop-in target glow). */
  setPadGlow(on: boolean) {
    if (this.padMat) this.padMat.opacity = on ? 0.85 : 0.4
  }

  private own<T extends THREE.Material>(m: T): T { this.mats.push(m); return m }
  private ownG<T extends THREE.BufferGeometry>(g: T): T { this.geos.push(g); return g }
  private ownT<T extends THREE.Texture>(t: T): T { this.texs.push(t); return t }

  setActive(on: boolean) {
    this.active = on
    this.group.visible = on
    if (!on) this.clearWalkers()
  }

  /** Solid AABB colliders for the shell (back + side walls + corner pillars +
   *  intake tower), transformed to world space. The front is left open so you can
   *  walk in to the assembly floor. */
  colliderBoxes(): THREE.Box3[] {
    return this.colliders
  }

  private build() {
    const box = (w: number, h: number, d: number, m: THREE.Material) => new THREE.Mesh(this.ownG(new THREE.BoxGeometry(w, h, d)), m)

    // --- materials: dark navy body, cyan neon trim, tinted glass, lit interior ---
    const navy = this.own(new THREE.MeshStandardMaterial({ color: 0x16203c, metalness: 0.55, roughness: 0.45, emissive: 0x0a1230, emissiveIntensity: 0.4 }))
    const navyDark = this.own(new THREE.MeshStandardMaterial({ color: 0x0c1226, metalness: 0.5, roughness: 0.6 }))
    const trim = this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, fog: true })) // neon edge glow
    const trimDim = this.own(new THREE.MeshBasicMaterial({ color: 0x1488c8, fog: true }))
    const glass = this.own(new THREE.MeshStandardMaterial({ color: 0x0a2b4a, metalness: 0.2, roughness: 0.08, transparent: true, opacity: 0.34, emissive: 0x0a3a5e, emissiveIntensity: 0.5, side: THREE.DoubleSide }))
    const deck = this.own(new THREE.MeshStandardMaterial({ color: 0x10182c, metalness: 0.5, roughness: 0.7 }))
    const steel = this.own(new THREE.MeshStandardMaterial({ color: 0x3a4350, metalness: 0.8, roughness: 0.35 }))
    const litWarm = this.own(new THREE.MeshBasicMaterial({ color: 0xbfe6ff }))

    // --- base podium (sits on a slightly oversized navy platform with a cyan lip) ---
    const baseW = W + 6, baseD = D + 6
    const podium = box(baseW, 1.2, baseD, navyDark); podium.position.set(0, 0.0, -D / 2); podium.receiveShadow = true; this.group.add(podium)
    const lip = box(baseW + 0.4, 0.25, baseD + 0.4, trimDim); lip.position.set(0, 0.62, -D / 2); this.group.add(lip)

    // --- floor decks (3) ---
    for (let f = 0; f <= FLOORS; f++) {
      const y = 0.7 + f * FH
      const slab = box(W, 0.4, D, deck); slab.position.set(0, y, -D / 2); slab.receiveShadow = true; this.group.add(slab)
      // Cyan neon edge-trim running along the front + sides of each floor slab.
      const front = box(W + 0.3, 0.16, 0.16, trim); front.position.set(0, y + 0.32, 0.05); this.group.add(front)
      for (const sx of [-1, 1]) { const side = box(0.16, 0.16, D + 0.3, trim); side.position.set((sx * W) / 2 + sx * 0.15, y + 0.32, -D / 2); this.group.add(side) }
    }

    // --- back + side walls (solid navy; sides carry tall glass panels) ---
    const back = box(W, H, 0.6, navy); back.position.set(0, H / 2 + 0.7, -D); back.castShadow = true; this.group.add(back)
    for (const sx of [-1, 1]) {
      const wall = box(0.6, H, D, navy); wall.position.set((sx * W) / 2, H / 2 + 0.7, -D / 2); this.group.add(wall)
      // Glass band on the side, per upper floor, so the assembly reads from outside.
      for (let f = 1; f < FLOORS; f++) {
        const g = box(0.2, FH - 1.2, D - 3, glass); g.position.set((sx * W) / 2 - sx * 0.35, 0.7 + f * FH + FH / 2, -D / 2); this.group.add(g)
      }
    }
    // Glass front on the upper two floors (ground floor stays open as the entrance).
    for (let f = 1; f < FLOORS; f++) {
      const g = box(W - 3, FH - 1.2, 0.2, glass); g.position.set(0, 0.7 + f * FH + FH / 2, -0.2); this.group.add(g)
    }

    // --- corner light-pillars (chunky, with a vertical cyan strip facing out) ---
    for (const sx of [-1, 1]) for (const cz of [0, -D]) {
      const pil = box(2.2, H + 1.4, 2.2, navy); pil.position.set((sx * (W + 1)) / 2, (H + 1.4) / 2 + 0.7, cz); pil.castShadow = true; this.group.add(pil)
      const strip = box(0.3, H - 1, 0.3, trim); strip.position.set((sx * (W + 1)) / 2 + sx * 1.15, H / 2 + 0.7, cz + (cz === 0 ? 1.15 : -1.15)); this.group.add(strip)
      const cap = box(2.6, 0.4, 2.6, trimDim); cap.position.set((sx * (W + 1)) / 2, H + 1.6, cz); this.group.add(cap)
    }

    // --- big octagonal robot-head logo on the front of the top floor ---
    const logoHousing = box(9.5, 9.5, 0.6, navyDark); logoHousing.position.set(-W * 0.18, 0.7 + 2 * FH + FH / 2 + 0.4, 0.35); this.group.add(logoHousing)
    this.logoMat = this.own(new THREE.MeshBasicMaterial({ map: this.ownT(this.logoTexture()), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const logo = new THREE.Mesh(this.ownG(new THREE.PlaneGeometry(8.6, 8.6)), this.logoMat)
    logo.position.set(-W * 0.18, 0.7 + 2 * FH + FH / 2 + 0.4, 0.72); this.group.add(logo)

    // --- rooftop: skylight panels + an antenna beacon spire ---
    const roof = box(W, 0.5, D, navy); roof.position.set(0, H + 0.95, -D / 2); roof.castShadow = true; this.group.add(roof)
    for (let i = -1; i <= 1; i++) {
      const sky = box(W * 0.26, 0.5, D * 0.5, glass); sky.position.set(i * W * 0.3, H + 1.25, -D / 2); this.group.add(sky)
    }
    // Thin antenna near a back corner with a bright cyan tip (the concept's beacon).
    const mast = box(0.3, 6, 0.3, steel); mast.position.set(W * 0.32, H + 4, -D + 2); this.group.add(mast)
    this.beaconMat = this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, fog: false }))
    const beacon = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.45, 10, 8)), this.beaconMat)
    beacon.position.set(W * 0.32, H + 7.4, -D + 2); this.group.add(beacon)
    const beaconGlow = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.9, 10, 8)), this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    beaconGlow.position.copy(beacon.position); this.group.add(beaconGlow)

    // --- hazard-striped entrance ramp at the front, leading up to the ground floor ---
    const ramp = new THREE.Mesh(this.ownG(new THREE.BoxGeometry(11, 0.4, 7)), this.own(new THREE.MeshStandardMaterial({ map: this.ownT(this.hazardTexture()), metalness: 0.4, roughness: 0.6 })))
    ramp.position.set(-6, 0.5, 4.4); ramp.rotation.x = 0.12; this.group.add(ramp)

    // --- interior assembly (visible through the open front + glass) ---
    this.buildAssembly(box, steel, litWarm)

    // Interior fill so the hall reads as a lit space.
    const lamp1 = new THREE.PointLight(0x9fe8ff, 2.6, 56, 2); lamp1.position.set(-4, 9, -D / 2); this.group.add(lamp1)
    const lamp2 = new THREE.PointLight(0x49b6ff, 1.6, 44, 2); lamp2.position.set(8, 6, -D / 2 + 2); this.group.add(lamp2)
  }

  /** Conveyor line, half-built units, swinging arms, stamping press + charging
   *  bays - the functional "robots building robots" guts, on the ground floor. */
  private buildAssembly(box: (w: number, h: number, d: number, m: THREE.Material) => THREE.Mesh, steel: THREE.Material, lit: THREE.Material) {
    const unitMat = this.own(new THREE.MeshStandardMaterial({ color: config.palette.robot, metalness: 0.7, roughness: 0.4 }))
    // Conveyor belt running front-to-back through the hall.
    const belt = box(3.2, 0.4, D - 4, steel); belt.position.set(-6, 1.4, -D / 2); this.group.add(belt)
    for (let i = 0; i < 5; i++) {
      const u = new THREE.Group()
      const torso = box(0.6, 0.9, 0.5, unitMat); torso.position.y = 0.85; u.add(torso)
      const head = box(0.4, 0.4, 0.4, unitMat); head.position.y = 1.5; u.add(head)
      u.scale.setScalar(0.6 + i * 0.1)
      u.position.set(-6, 1.6, -D + 2 + i * 4)
      this.group.add(u); this.belt.push(u)
    }
    // Robotic assembly arms over the line.
    for (let i = 0; i < 3; i++) {
      const pivot = new THREE.Group()
      pivot.position.set(-6 + (i - 1) * 0.5, 3.6, -D + 5 + i * 5.5)
      const upper = box(0.3, 2.4, 0.3, steel); upper.position.y = -1.0; pivot.add(upper)
      const fore = box(0.24, 1.6, 0.24, steel); fore.position.set(0, -2.4, 0.5); pivot.add(fore)
      const tip = new THREE.Mesh(this.ownG(new THREE.SphereGeometry(0.16, 8, 8)), this.own(new THREE.MeshBasicMaterial({ color: 0xbfe6ff })))
      tip.position.set(0, -3.1, 0.9); pivot.add(tip)
      this.sparks.push(tip.material as THREE.MeshBasicMaterial)
      const base = box(0.5, 0.6, 0.5, steel); base.position.set(-6 + (i - 1) * 0.5, 3.9, -D + 5 + i * 5.5); this.group.add(base)
      this.group.add(pivot)
      this.arms.push({ pivot, speed: 2 + i * 0.5, phase: i * 1.7 })
    }
    // Stamping press near the line head.
    this.press = box(3.4, 1.2, 2.4, steel)
    this.press.position.set(-6, 5.2, -D + 4); this.group.add(this.press)
    for (const sx of [-1.6, 1.6]) { const col = box(0.4, 5, 0.4, steel); col.position.set(-6 + sx, 2.9, -D + 4); this.group.add(col) }
    // Charging bays (glowing cyan) on the other side.
    const bay = this.own(new THREE.MeshStandardMaterial({ color: 0x05060b, emissive: config.palette.cyan, emissiveIntensity: 2.0, roughness: 0.5 }))
    for (let i = 0; i < 4; i++) { const c = box(0.2, 1.6, 0.5, bay); c.position.set(9, 1.3, -D + 3 + i * 2.2); this.group.add(c) }
    void lit

    // Intake tower over the back: a tall spire with an open rooftop landing pad -
    // the "drop in through the roof" target.
    const TH = 26
    const tower = box(11, TH, 11, this.own(new THREE.MeshStandardMaterial({ color: 0x101a34, metalness: 0.55, roughness: 0.45, emissive: 0x0a1230, emissiveIntensity: 0.4 })))
    tower.position.set(0, TH / 2, -18); tower.castShadow = true; this.group.add(tower)
    for (let i = 1; i < 5; i++) { const band = box(11.4, 0.4, 11.4, this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, fog: true }))); band.position.set(0, i * (TH / 5), -18); this.group.add(band) }
    const collar = box(13, 1.2, 13, steel); collar.position.set(0, TH, -18); this.group.add(collar)
    this.padMat = this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }))
    const padRing = new THREE.Mesh(this.ownG(new THREE.RingGeometry(3.2, 5, 36)), this.padMat)
    padRing.rotation.x = -Math.PI / 2; padRing.position.set(0, TH + 0.7, -18); this.group.add(padRing)
    const shaft = new THREE.Mesh(this.ownG(new THREE.CylinderGeometry(2.6, 2.6, TH, 16, 1, true)), this.own(new THREE.MeshBasicMaterial({ color: config.palette.cyan, transparent: true, opacity: 0.1, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })))
    shaft.position.set(0, TH / 2, -18); this.group.add(shaft)
  }

  /** Solid shell colliders in world space: back + two side walls + the four
   *  corner pillars + the intake tower. Front (z~0) is left open as the entrance. */
  private buildColliders() {
    const add = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) => {
      const b = new THREE.Box3(); const v = new THREE.Vector3()
      for (let i = 0; i < 8; i++) { v.set(cx + (i & 1 ? hx : -hx), cy + (i & 2 ? hy : -hy), cz + (i & 4 ? hz : -hz)); v.applyMatrix4(this.group.matrixWorld); b.expandByPoint(v) }
      this.colliders.push(b)
    }
    add(0, H / 2 + 0.7, -D, W / 2, H / 2, 0.8) // back wall
    add(-W / 2, H / 2 + 0.7, -D / 2, 0.8, H / 2, D / 2) // left wall
    add(W / 2, H / 2 + 0.7, -D / 2, 0.8, H / 2, D / 2) // right wall
    add(0, 13, -18, 5.5, 13, 5.5) // intake tower
    // Front corner pillars (so the open front's corners are still solid).
    for (const sx of [-1, 1]) add((sx * (W + 1)) / 2, H / 2, 0, 1.3, H / 2, 1.3)
  }

  /** A glowing octagonal robot-head logo drawn once to a canvas. */
  private logoTexture(): THREE.CanvasTexture {
    const s = 256
    const cv = document.createElement('canvas'); cv.width = s; cv.height = s
    const ctx = cv.getContext('2d')!
    ctx.clearRect(0, 0, s, s)
    const cyan = '#27e7ff'
    ctx.strokeStyle = cyan; ctx.fillStyle = cyan; ctx.shadowColor = cyan
    // Octagon outline.
    ctx.lineWidth = 10; ctx.shadowBlur = 26
    const cx = s / 2, cy = s / 2, R = 104, k = R * 0.41
    ctx.beginPath()
    const oct: [number, number][] = [[-k, -R], [k, -R], [R, -k], [R, k], [k, R], [-k, R], [-R, k], [-R, -k]]
    oct.forEach(([x, y], i) => { const px = cx + x, py = cy + y; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py) })
    ctx.closePath(); ctx.stroke()
    // Robot head: rounded square + antenna + two eyes.
    ctx.shadowBlur = 18; ctx.lineWidth = 12
    const hw = 46
    ctx.beginPath(); ctx.roundRect(cx - hw, cy - hw + 8, hw * 2, hw * 2, 16); ctx.stroke()
    // antenna
    ctx.lineWidth = 9; ctx.beginPath(); ctx.moveTo(cx, cy - hw + 8); ctx.lineTo(cx, cy - hw - 18); ctx.stroke()
    ctx.beginPath(); ctx.arc(cx, cy - hw - 24, 8, 0, Math.PI * 2); ctx.fill()
    // eyes
    ctx.beginPath(); ctx.arc(cx - 20, cy + 12, 13, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(cx + 20, cy + 12, 13, 0, Math.PI * 2); ctx.fill()
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }

  /** Yellow/black hazard stripes for the entrance ramp. */
  private hazardTexture(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128
    const ctx = cv.getContext('2d')!
    ctx.fillStyle = '#14161c'; ctx.fillRect(0, 0, 128, 128)
    ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 16
    for (let i = -128; i < 256; i += 40) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 128, 128); ctx.stroke() }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(2, 1)
    return tex
  }

  /** A city target for a freshly-built robot: head to a road to ride off, to the
   *  spaceport, or just roam. Returned in world space. */
  private pickDestination(): THREE.Vector3 {
    const r = Math.random()
    if (r < 0.4) {
      const pitch = config.world.block + config.world.roadWidth
      const gx = (Math.round((Math.random() * 2 - 1) * 3) * pitch)
      return new THREE.Vector3(gx, 0, (Math.random() * 2 - 1) * 60)
    }
    if (r < 0.62) {
      return new THREE.Vector3(-14 + Math.random() * 30, 0, -24 + Math.random() * 6)
    }
    const a = Math.random() * Math.PI * 2
    const d = 40 + Math.random() * 90
    return new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d)
  }

  private emitRobot() {
    const cap = config.tier.fxScale >= 0.9 ? 9 : config.tier.fxScale >= 0.6 ? 6 : 4
    if (this.walkers.length >= cap) return
    const model = createCitizen({ outfit: config.palette.robot, robot: true })
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
    this.press.position.y = 5.2 + Math.abs(Math.sin(this.t * 2.2)) * -0.8 + 0.4
    // Logo + beacon pulse.
    if (this.logoMat) this.logoMat.opacity = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(this.t * 2))
    if (this.beaconMat) this.beaconMat.opacity = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.t * 4))
    // Belt advances; units that reach the front recycle to the back + a finished
    // robot is emitted into the city.
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
    this.texs.forEach((t) => t.dispose())
  }
}
